import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { HoldKeyChoice, HoldKeyStatus } from "@shared/types";

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("down") }),
  z.object({ type: z.literal("up") }),
  z.object({ type: z.literal("error"), reason: z.enum(["permission", "tap", "input"]) })
]);

const MAX_LINE_LENGTH = 256;
const PERMISSION_EXIT_CODE = 3;
const RESTART_DELAY_MS = 1000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;
const ONE_SHOT_DEADLINE_MS = 5000;

/** Runs the key helper only while a key is chosen and permission exists. */
export class HoldKeyService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private watching: Exclude<HoldKeyChoice, "off"> | null = null;
  private status: HoldKeyStatus = "off";
  private restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private disposed = false;
  onDown: (() => void) | null = null;
  onUp: (() => void) | null = null;

  constructor(
    private readonly executable: string,
    private readonly getKey: () => HoldKeyChoice,
    private readonly onStatus: (status: HoldKeyStatus) => void
  ) {}

  getStatus(): HoldKeyStatus {
    return this.status;
  }

  private setStatus(status: HoldKeyStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  private oneShot(argument: "--check" | "--request"): Promise<boolean> {
    return new Promise((resolve, reject) => {
      execFile(this.executable, [argument], { timeout: ONE_SHOT_DEADLINE_MS }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim() === "granted");
      });
    });
  }

  /** Brings the helper in line with the chosen key. Safe to call at any time. */
  async sync(restarting = false): Promise<void> {
    const generation = ++this.generation;
    // A restart must count against the limit. Anything else is a fresh attempt.
    if (!restarting) this.restarts = [];
    const key = this.getKey();
    if (key === "off" || process.platform !== "darwin") {
      this.stop();
      this.setStatus("off");
      return;
    }
    if (this.child && this.watching === key) return;

    await this.reach(generation, key, () => this.oneShot("--check"));
  }

  /** Permission granted in System Settings arrives with no event, so returning to the app rechecks it. */
  recheck(): void {
    if (this.status === "needs_permission") void this.sync();
  }

  async requestPermission(): Promise<HoldKeyStatus> {
    const generation = ++this.generation;
    const key = this.getKey();
    if (key === "off" || process.platform !== "darwin") return this.status;
    if (this.child && this.watching === key) return this.status;

    await this.reach(generation, key, () => this.oneShot("--request"));
    return this.status;
  }

  private async reach(generation: number, key: Exclude<HoldKeyChoice, "off">, askAccess: () => Promise<boolean>): Promise<void> {
    let granted: boolean;
    try {
      granted = await askAccess();
    } catch {
      if (generation === this.generation && !this.disposed) this.setStatus("unavailable");
      return;
    }
    if (generation !== this.generation || this.disposed) return;

    this.stop();
    if (!granted) {
      this.setStatus("needs_permission");
      return;
    }
    this.watch(key);
  }

  private watch(key: Exclude<HoldKeyChoice, "off">): void {
    const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.watching = key;
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.stdin.on("error", () => child.kill("SIGTERM"));
    child.once("error", () => this.childGone(child, null));
    child.once("close", (code) => {
      lines.close();
      this.childGone(child, code);
    });
    lines.on("line", (line) => {
      if (this.child === child) this.handleLine(child, line);
    });
    child.stdin.write(`${JSON.stringify({ type: "watch", key })}\n`);
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

    if (event.type === "ready") this.setStatus("ready");
    else if (event.type === "down") this.onDown?.();
    else if (event.type === "up") this.onUp?.();
  }

  private childGone(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    const key = this.watching;
    this.watching = null;
    // The helper is the only witness to the key, so a hold cannot outlive it.
    this.onUp?.();
    if (this.disposed || !key) return;

    if (code === PERMISSION_EXIT_CODE) {
      this.setStatus("needs_permission");
      return;
    }
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.setStatus("unavailable");
      return;
    }
    this.restarts.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.sync(true);
    }, RESTART_DELAY_MS);
    this.restartTimer.unref();
  }

  private stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.watching = null;
    this.onUp?.();
    child.stdin.end();
    child.kill("SIGTERM");
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.stop();
  }
}
