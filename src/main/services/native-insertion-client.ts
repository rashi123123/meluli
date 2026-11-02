import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pipelineTrace } from "../pipeline-trace";
import { ProcessLines } from "./process-lines";

const replySchema = z.object({
  requestId: z.string(), state: z.enum(["ready", "captured", "confirmed", "unverified", "not_dispatched", "unresolved", "duplicate_blocked"]),
  reason: z.string(), targetToken: z.string().optional(),
  target: z.object({ name: z.string(), pid: z.number().int().positive(), bundleId: z.string(),
    role: z.string().optional(), method: z.string().optional(), insertability: z.enum(["verified", "blind", "secure"]).optional(), capability: z.string().optional(), frameworkVersion: z.string().optional(), textSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    selectionStart: z.number().int().nonnegative().optional(), selectionLength: z.number().int().nonnegative().optional() }).optional(),
  totalMs: z.number().optional(), cpuMs: z.number().optional(), stagesMs: z.record(z.string(), z.number()).optional()
});
export type NativeInsertionReply = z.infer<typeof replySchema>;
export class NativeInsertionFailure extends Error {
  /** `answered`: a live helper sent something unreadable, so it is a refusal, not an unavailable helper. */
  constructor(public readonly state: string, message: string, public readonly answered = false) { super(message); }
}
export interface NativeInsertOptions { explicit?: boolean }
/** One bounded outstanding request. Strict clients quarantine on an unresolved outcome; adaptive ones keep working, since operation ids and spent tokens already stop a resend. */
export class NativeInsertionClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private pending: { id: string; mutation: boolean; resolve: (reply: NativeInsertionReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private inFlight: Promise<unknown> = Promise.resolve();
  private ready: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private quarantined = false;
  private disposed = false;
  private attemptedOperations = new Set<string>();
  /** The app in front, once the helper has seen a change. Null until then. */
  frontmostPid: number | null = null;
  onFrontmostChanged: ((pid: number) => void) | null = null;
  constructor(private readonly executable: string, private readonly deadlineMs = 4000, private readonly startupDeadlineMs = 4000,
    private readonly method: "ax_selected_text" | "unicode_events" | "native_paste" = "ax_selected_text",
    private readonly adaptive = false) {}
  get usesClipboard(): boolean { return this.method === "native_paste"; }
  private fail(reason: string, answered = false): void {
    if (!this.adaptive) this.quarantined = true;
    const error = new NativeInsertionFailure(this.pending?.mutation ? "unresolved" : "not_dispatched", reason, answered);
    this.startReject?.(error); this.ready = null; this.startReject = null;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    this.child?.kill("SIGTERM");
    // The replacement knows no target token, so it cannot paste anything captured here.
    if (this.adaptive) { this.child = null; this.startPromise = null; }
  }
  private start(): Promise<void> {
    if (this.disposed || this.quarantined) return Promise.reject(new NativeInsertionFailure("unresolved", "Native insertion requires manual recovery; no automatic restart."));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      pipelineTrace("persistent_helper_start", "start");
      const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] }); this.child = child;
      const timer = setTimeout(() => this.fail("Native helper readiness deadline."), this.startupDeadlineMs); timer.unref();
      this.ready = () => { clearTimeout(timer); this.startReject = null; pipelineTrace("persistent_helper_start", "end"); resolve(); };
      this.startReject = error => { clearTimeout(timer); reject(error); };
      const lines = new ProcessLines(child.stdout);
      child.stderr.resume(); // Never retain arbitrary native stderr/private payloads.
      const failCurrent = (reason: string) => { if (this.child === child) this.fail(reason); };
      child.stdin.on("error", () => failCurrent("Native helper input unavailable."));
      child.once("error", () => failCurrent("Native helper unavailable."));
      child.once("close", () => { lines.close(); if (!this.disposed) failCurrent("Native helper exited; no automatic retry."); });
      lines.on("line", line => {
        if (this.child !== child) return;
        if (line.length > 65536) { this.fail("Native protocol response too large.", true); return; }
        let value: unknown;
        try { value = JSON.parse(line); } catch { this.fail("Invalid native response.", true); return; }
        if (this.ready && typeof value === "object" && value !== null && "type" in value && value.type === "ready" && "protocol" in value && (value.protocol === 1 || value.protocol === 2 || value.protocol === 3)) {
          const ready = this.ready; this.ready = null; ready(); return;
        }
        if (typeof value === "object" && value !== null && "type" in value && value.type === "frontmost" && "pid" in value && typeof value.pid === "number") {
          this.frontmostPid = value.pid; this.onFrontmostChanged?.(value.pid); return;
        }
        const parsed = replySchema.safeParse(value);
        if (!parsed.success || !this.pending || parsed.data.requestId !== this.pending.id) { this.fail("Stale or malformed native response.", true); return; }
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
        const reply = parsed.data;
        pipelineTrace("persistent_native_reply", "event", { state: reply.state, reason: reply.reason, totalMs: reply.totalMs ?? 0, cpuMs: reply.cpuMs ?? 0 });
        for (const [stage, durationMs] of Object.entries(reply.stagesMs ?? {})) pipelineTrace("native_" + stage, "measurement", { durationMs });
        if (!this.adaptive && (reply.state === "unresolved" || reply.state === "duplicate_blocked")) this.quarantined = true;
        pending.resolve(reply);
      });
    });
    return this.startPromise;
  }
  private async call(request: Record<string, string | number | boolean>): Promise<NativeInsertionReply> {
    await this.start();
    // Busy is not unavailable: wait out the request ahead, whose deadline bounds this, on whatever helper is left.
    while (this.pending) { await this.inFlight; await this.start(); }
    if (this.quarantined || this.disposed) throw new NativeInsertionFailure("not_dispatched", "Native insertion requires inspection.");
    const id = randomUUID();
    const reply = new Promise<NativeInsertionReply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail("Native response deadline; inspect target before recovery."), this.deadlineMs); timer.unref();
      this.pending = { id, mutation: request.type === "insert", resolve, reject, timer };
      this.child!.stdin.write(JSON.stringify({ ...request, requestId: id }) + "\n");
    });
    this.inFlight = reply.catch(() => undefined);
    return reply;
  }
  async capture() {
    const reply = await this.call({ type: "capture", excludePid: process.pid, method: this.method, ...(this.adaptive ? { adaptive: true } : {}) });
    if (reply.state !== "captured" || !reply.target || !reply.targetToken) throw new NativeInsertionFailure(reply.state, reply.reason);
    return { target: reply.target, token: reply.targetToken };
  }
  async insert(token: string, text: string, operationId = token, options: NativeInsertOptions = {}): Promise<"confirmed" | "unverified"> {
    if (!operationId || operationId.length > 256 || !token || !text || Buffer.byteLength(text) > 1_000_000)
      throw new NativeInsertionFailure("not_dispatched", "Invalid native insertion payload.");
    // Claim synchronously before awaiting startup. Concurrent callers and a later
    // recapture cannot resend a previously attempted transcript through this client.
    if (this.attemptedOperations.has(operationId)) throw new NativeInsertionFailure("duplicate_blocked", "Operation already attempted; inspect the target.");
    if (this.attemptedOperations.size >= 10000) throw new NativeInsertionFailure("not_dispatched", "Native session capacity reached.");
    this.attemptedOperations.add(operationId);
    let reply: NativeInsertionReply;
    try {
      reply = await this.call({ type: "insert", operationId, targetToken: token, text, ...(options.explicit ? { explicit: true } : {}) });
    } catch (error) {
      // The helper never got this request. Every other failure may have reached it and stays claimed.
      if (this.adaptive && error instanceof NativeInsertionFailure && error.state === "not_dispatched") this.attemptedOperations.delete(operationId);
      throw error;
    }
    if (reply.state === "confirmed" || reply.state === "unverified") return reply.state;
    // Nothing was sent, so the same transcript may be offered again.
    if (this.adaptive && reply.state === "not_dispatched") this.attemptedOperations.delete(operationId);
    throw new NativeInsertionFailure(reply.state, reply.reason);
  }
  cancelUnresolvedInsertion(): void { this.fail("Native insertion interrupted; inspect target before manual recovery."); }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.startReject?.(new NativeInsertionFailure("unresolved", "Native startup interrupted by shutdown."));
    this.startReject = null; this.ready = null;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new NativeInsertionFailure("unresolved", "Insertion interrupted by shutdown.")); this.pending = null; }
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end('{"type":"quit"}\n');
    });
  }
}
