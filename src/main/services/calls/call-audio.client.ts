import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("apps"),
    apps: z.array(z.object({ id: z.string().max(256), input: z.boolean(), output: z.boolean() })).max(64)
  }),
  z.object({ type: z.literal("started") }),
  z.object({
    type: z.literal("stopped"),
    micOffsetMs: z.number().nonnegative(),
    systemOffsetMs: z.number().nonnegative(),
    systemHeard: z.boolean()
  }),
  z.object({ type: z.literal("error"), reason: z.enum(["microphone", "tap", "disk", "input"]) })
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

interface Pending<T> {
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
    if (!this.prefixes) return;
    const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.stdin.on("error", () => child.kill("SIGTERM"));
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
      child.kill("SIGTERM");
      return;
    }

    if (event.type === "apps") this.onApps?.(event.apps);
    else if (event.type === "started") this.settle("starting", true);
    else if (event.type === "stopped") {
      const { micOffsetMs, systemOffsetMs, systemHeard } = event;
      this.settle("stopping", { micOffsetMs, systemOffsetMs, systemHeard });
    } else if (event.type === "error") {
      if (event.reason === "disk") this.settle("starting", false);
      this.onFault?.(event.reason);
    }
  }

  private settle(which: "starting", value: boolean): void;
  private settle(which: "stopping", value: CallAudioStopped | null): void;
  private settle(which: "starting" | "stopping", value: never): void {
    const pending = this[which] as Pending<unknown> | null;
    if (!pending) return;
    this[which] = null;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  start(directory: string, prefixes: string[]): Promise<boolean> {
    if (!this.child) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.starting = { resolve, timer: setTimeout(() => this.settle("starting", false), START_DEADLINE_MS) };
      this.send({ type: "start", directory, prefixes });
    });
  }

  /** Null means the helper is gone. Its files are still readable. */
  stop(): Promise<CallAudioStopped | null> {
    if (!this.child) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.stopping = { resolve, timer: setTimeout(() => this.settle("stopping", null), STOP_DEADLINE_MS) };
      this.send({ type: "stop" });
    });
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
