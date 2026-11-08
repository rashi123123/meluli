import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as z from "zod";
import { endHelper, RestartBudget, sendLine, spawnLineHelper } from "../line-helper";

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("apps"),
    apps: z.array(z.object({ id: z.string().max(256), input: z.boolean(), output: z.boolean() })).max(64)
  }),
  z.object({ type: z.literal("started"), id: z.number().int() }),
  z.object({
    type: z.literal("stopped"),
    id: z.number().int(),
    micOffsetMs: z.number().nonnegative(),
    systemOffsetMs: z.number().nonnegative(),
    systemHeard: z.boolean()
  }),
  /** An id means the helper refused that start. */
  z.object({ type: z.literal("error"), reason: z.enum(["microphone", "tap", "disk", "input"]), id: z.number().int().optional() })
]);

export type CallAudioFault = "microphone" | "tap" | "disk" | "input";
export type HelperApp = { id: string; input: boolean; output: boolean };
export type CallAudioStopped = { micOffsetMs: number; systemOffsetMs: number; systemHeard: boolean };

const MAX_LINE_LENGTH = 8192;
const START_DEADLINE_MS = 10_000;
const STOP_DEADLINE_MS = 5_000;
const KILL_GRACE_MS = 1_000;

interface Pending<T> {
  id: number;
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

/** The helper reports activity and writes audio. No audio or call content passes through this class. */
export class CallAudioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private prefixes: string[] | null = null;
  private readonly restarts = new RestartBudget();
  private starting: Pending<boolean> | null = null;
  private stopping: Pending<CallAudioStopped | null> | null = null;
  private lastRequest = 0;
  onApps: ((apps: HelperApp[]) => void) | null = null;
  onFault: ((reason: CallAudioFault) => void) | null = null;
  /** The helper ended while it may have been recording. */
  onGone: (() => void) | null = null;

  constructor(private readonly executable: string) {}

  /** Starts or stops watching. A null list stops the helper. */
  watch(prefixes: string[] | null): void {
    this.prefixes = prefixes;
    this.restarts.reset();
    if (!prefixes) {
      this.shutdown();
      return;
    }
    if (this.child) this.send({ type: "watch", prefixes });
    else this.launch();
  }

  private launch(): void {
    if (!this.prefixes || this.child) return;
    this.child = spawnLineHelper(this.executable, { schema: eventSchema, maxLineLength: MAX_LINE_LENGTH }, {
      isCurrent: (candidate) => this.child === candidate,
      onEvent: (_child, event) => this.handleEvent(event),
      onGone: (gone) => this.childGone(gone)
    });
    this.send({ type: "watch", prefixes: this.prefixes });
  }

  private send(message: object): void {
    if (this.child) sendLine(this.child, message);
  }

  private handleEvent(event: z.infer<typeof eventSchema>): void {
    if (event.type === "apps") this.onApps?.(event.apps);
    else if (event.type === "started") this.settle("starting", true, event.id);
    else if (event.type === "stopped") {
      const { id, micOffsetMs, systemOffsetMs, systemHeard } = event;
      this.settle("stopping", { micOffsetMs, systemOffsetMs, systemHeard }, id);
    } else if (event.type === "error") {
      if (event.id !== undefined) this.settle("starting", false, event.id);
      this.onFault?.(event.reason);
    }
  }

  /** Without an id it settles whatever is waiting. With one, a late reply cannot answer a newer request. */
  private settle(which: "starting", value: boolean, id?: number): void;
  private settle(which: "stopping", value: CallAudioStopped | null, id?: number): void;
  private settle(which: "starting" | "stopping", value: never, id?: number): void {
    const pending = this[which] as Pending<unknown> | null;
    if (!pending || (id !== undefined && id !== pending.id)) return;
    this[which] = null;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  start(directory: string, prefixes: string[]): Promise<boolean> {
    const child = this.child;
    if (!child) return Promise.resolve(false);
    const id = ++this.lastRequest;
    return new Promise((resolve) => {
      this.starting = { id, resolve, timer: setTimeout(() => this.abandonStart(child, id), START_DEADLINE_MS) };
      this.send({ type: "start", id, directory, prefixes });
    });
  }

  /** The caller drops the folder next, so a helper still starting must not go on capturing to it. */
  private abandonStart(child: ChildProcessWithoutNullStreams, id: number): void {
    if (this.child === child) this.send({ type: "stop", id: ++this.lastRequest });
    this.terminate(child);
    this.settle("starting", false, id);
  }

  /** Null means the helper is gone. Its files are still readable. */
  stop(): Promise<CallAudioStopped | null> {
    const child = this.child;
    if (!child) return Promise.resolve(null);
    const id = ++this.lastRequest;
    return new Promise((resolve) => {
      this.stopping = { id, resolve, timer: setTimeout(() => this.abandonStop(child, id), STOP_DEADLINE_MS) };
      this.send({ type: "stop", id });
    });
  }

  /** The screen says the call has stopped and the caller reads the files next, so a helper that did not answer has to end first. */
  private abandonStop(child: ChildProcessWithoutNullStreams, id: number): void {
    this.terminate(child, () => this.settle("stopping", null, id));
  }

  /** A stuck helper can ignore SIGTERM and keep capturing. */
  private terminate(child: ChildProcessWithoutNullStreams, done?: () => void): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      done?.();
      return;
    }
    endHelper(child, KILL_GRACE_MS);
    if (done) setTimeout(done, KILL_GRACE_MS).unref();
  }

  private childGone(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = null;
    this.settle("starting", false);
    this.settle("stopping", null);
    this.onApps?.([]);
    this.onGone?.();
    if (!this.prefixes) return;

    this.restarts.schedule(() => this.launch());
  }

  private shutdown(): void {
    this.restarts.cancel();
    const child = this.child;
    if (!child) return;
    this.child = null;
    // End of input makes the helper close its files before it exits.
    child.stdin.end();
  }

  dispose(): void {
    this.prefixes = null;
    this.shutdown();
  }
}
