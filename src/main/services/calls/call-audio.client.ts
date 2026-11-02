import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { ProcessLines } from "../process-lines";

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
const RESTART_DELAY_MS = 1000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;
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
  private restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
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
    this.restarts = [];
    if (!prefixes) {
      this.shutdown();
      return;
    }
    if (this.child) this.send({ type: "watch", prefixes });
    else this.launch();
  }

  private launch(): void {
    if (!this.prefixes || this.child) return;
    const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const lines = new ProcessLines(child.stdout);
    child.stderr.resume();
    child.stdin.on("error", () => this.terminate(child));
    child.once("error", () => this.childGone(child));
    child.once("close", () => {
      lines.close();
      this.childGone(child);
    });
    lines.on("line", (line) => {
      if (this.child === child) this.handleLine(child, line);
    });
    this.send({ type: "watch", prefixes: this.prefixes });
  }

  private send(message: object): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let event: z.infer<typeof eventSchema>;
    try {
      if (line.length > MAX_LINE_LENGTH) throw new Error("line too long");
      event = eventSchema.parse(JSON.parse(line));
    } catch {
      this.terminate(child);
      return;
    }

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
    const running = () => child.exitCode === null && child.signalCode === null;
    if (!running()) {
      done?.();
      return;
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (running()) child.kill("SIGKILL");
      done?.();
    }, KILL_GRACE_MS).unref();
  }

  private childGone(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = null;
    this.settle("starting", false);
    this.settle("stopping", null);
    this.onApps?.([]);
    this.onGone?.();
    if (!this.prefixes) return;

    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) return;
    this.restarts.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, RESTART_DELAY_MS);
    this.restartTimer.unref();
  }

  private shutdown(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
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
