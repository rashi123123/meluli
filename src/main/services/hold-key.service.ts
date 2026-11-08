import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as z from "zod";
import type { HoldKeyChoice, HoldKeyStatus } from "@shared/types";
import { endHelper, RestartBudget, sendLine, spawnLineHelper } from "./line-helper";
import { minimalChildEnv } from "./child-env";

/** The failure reasons native/HoldKey.swift reports before it exits (checked against the Swift source in a test). */
export const HOLD_KEY_FAILURES = ["permission", "tap", "input"] as const;
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("down") }),
  z.object({ type: z.literal("up") }),
  z.object({ type: z.literal("error"), reason: z.enum(HOLD_KEY_FAILURES) })
]);

type HelperFailure = Extract<z.infer<typeof eventSchema>, { type: "error" }>["reason"];

const MAX_LINE_LENGTH = 256;
const PERMISSION_EXIT_CODE = 3;
const ONE_SHOT_DEADLINE_MS = 5000;

/** Runs the key helper only while a key is chosen and permission exists. */
export class HoldKeyService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private watching: Exclude<HoldKeyChoice, "off"> | null = null;
  private status: HoldKeyStatus = "off";
  private readonly restarts = new RestartBudget();
  private generation = 0;
  private disposed = false;
  /** The reason in the running helper's last `error` line; the helper exits 3 after every one. */
  private lastFailure: HelperFailure | null = null;
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
      execFile(this.executable, [argument], { timeout: ONE_SHOT_DEADLINE_MS, env: minimalChildEnv(process.env) }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim() === "granted");
      });
    });
  }

  /** Brings the helper in line with the chosen key. Safe to call at any time. */
  async sync(restarting = false): Promise<void> {
    const generation = ++this.generation;
    // A restart must count against the limit. Anything else is a fresh attempt.
    if (!restarting) this.restarts.reset();
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
    const child = spawnLineHelper(this.executable, { schema: eventSchema, maxLineLength: MAX_LINE_LENGTH }, {
      isCurrent: (candidate) => this.child === candidate,
      onEvent: (_child, event) => this.handleEvent(event),
      onGone: (gone, code) => this.childGone(gone, code)
    });
    this.child = child;
    this.watching = key;
    this.lastFailure = null;
    sendLine(child, { type: "watch", key });
  }

  private handleEvent(event: z.infer<typeof eventSchema>): void {
    if (event.type === "ready") this.setStatus("ready");
    else if (event.type === "down") this.onDown?.();
    else if (event.type === "up") this.onUp?.();
    else this.lastFailure = event.reason;
  }

  private childGone(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    const key = this.watching;
    this.watching = null;
    // The helper is the only witness to the key, so a hold cannot outlive it.
    this.onUp?.();
    if (this.disposed || !key) return;

    // Exit 3 follows every reported failure. Only a missing permission waits for the user; a tap
    // that failed with permission granted, or a refused line, restarts within the budget. An exit 3
    // with no reason read keeps the old reading.
    const failure = this.lastFailure;
    this.lastFailure = null;
    if (code === PERMISSION_EXIT_CODE && (failure === null || failure === "permission")) {
      this.setStatus("needs_permission");
      return;
    }
    if (!this.restarts.schedule(() => void this.sync(true))) this.setStatus("unavailable");
  }

  private stop(): void {
    this.restarts.cancel();
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.watching = null;
    this.onUp?.();
    child.stdin.end();
    endHelper(child);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.stop();
  }
}
