import { spawn } from "node:child_process";
import { pipelineTrace } from "../../diagnostics/pipeline-trace";
import { ProcessLines } from "../process-lines";
import { minimalChildEnv } from "../child-env";

/** native/ClipboardBridge.swift puts the user's clipboard back on its own after this long. */
const NATIVE_RESTORE_MS = 8_000;
/** The helper is stopped if it has not exited this long after a restore began. */
const RESTORE_BACKSTOP_MS = NATIVE_RESTORE_MS + 2_000;
const KILL_GRACE_MS = 1_000;
const READY_TIMEOUT_MS = 3_000;

export interface ClipboardLease { restore(): Promise<void>; quarantine?(): Promise<void> }

/** The clipboard could not be saved first, so nothing was pasted. Carries no clipboard content. */
export class ClipboardUnavailableError extends Error {}

/** Native pasteboard items preserve all formats; its change counter protects new copies. */
export class ClipboardBridgeService {
  constructor(private readonly executable: string) {}

  begin(text: string): Promise<ClipboardLease> {
    return new Promise((resolve, reject) => {
      pipelineTrace("clipboard_begin", "start");
      const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "ignore"], env: minimalChildEnv(process.env) });
      const lines = new ProcessLines(child.stdout);
      let ready = false;
      let expired = false;
      let startupFailure: ClipboardUnavailableError | null = null;
      let closed = false;
      let restoration: Promise<void> | null = null;
      let finish: (() => void) | null = null;
      let terminateTimer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        pipelineTrace("clipboard_process", "closed", { ready, expired });
        clearTimeout(readyTimer);
        if (terminateTimer) clearTimeout(terminateTimer);
        if (killTimer) clearTimeout(killTimer);
        lines.close(); finish?.();
        if (!ready) reject(startupFailure ?? new ClipboardUnavailableError("Clipboard helper unavailable."));
      };
      const restore = (): Promise<void> => {
        if (closed) return Promise.resolve();
        if (restoration) return restoration;
        restoration = new Promise<void>(done => {
          pipelineTrace("clipboard_restore", "start");
          finish = () => { pipelineTrace("clipboard_restore", "end"); done(); };
          child.stdin.end();
          // The helper has its own restoration deadline (NATIVE_RESTORE_MS). Allow it to finish,
          // but never let an unresponsive child hold the dictation queue forever.
          terminateTimer = setTimeout(() => {
            if (closed) return;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              if (!closed) child.kill("SIGKILL");
              close();
            }, KILL_GRACE_MS);
            killTimer.unref();
          }, RESTORE_BACKSTOP_MS);
          terminateTimer.unref();
        });
        return restoration;
      };
      const failStartup = (message: string) => {
        if (ready || expired) return;
        expired = true;
        pipelineTrace("clipboard_begin", "failed", { reason: message });
        startupFailure = new ClipboardUnavailableError(message);
        clearTimeout(readyTimer);
        // Keep the insertion pending until the previous helper has restored or
        // exited. Otherwise another dictation can snapshot its temporary text.
        void restore().then(() => reject(startupFailure));
      };
      const readyTimer = setTimeout(() => {
        failStartup("Clipboard helper did not become ready.");
      }, READY_TIMEOUT_MS);
      readyTimer.unref();
      child.once("error", close);
      child.once("close", close);
      child.stdin.on("error", () => failStartup("Clipboard helper unavailable."));
      lines.on("line", line => {
        if (/^\{"restored":(?:true|false)\}$/.test(line)) pipelineTrace("clipboard_restore", "ack", { restored: line.includes("true") });
        if (ready || expired || line !== '{"ready":true}') return;
        ready = true; clearTimeout(readyTimer);
        pipelineTrace("clipboard_begin", "end");
        resolve({ restore, quarantine: () => {
          // Keep the exact paste payload until the helper's own restore watchdog (NATIVE_RESTORE_MS)
          // expires. Do not immediately expose a different clipboard to an
          // unacknowledged queued event; do not allow another insertion meanwhile.
          if (closed) return Promise.resolve();
          if (restoration) return restoration;
          restoration = new Promise<void>(done => {
            pipelineTrace("clipboard_quarantine", "start");
            finish = () => { pipelineTrace("clipboard_quarantine", "end"); done(); };
            terminateTimer = setTimeout(() => {
              if (closed) return;
              child.kill("SIGTERM");
              killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); close(); }, KILL_GRACE_MS);
            }, RESTORE_BACKSTOP_MS);
          });
          return restoration;
        } });
      });
      // Pipe only: text is never placed in process arguments, a file or logs.
      child.stdin.write(JSON.stringify({ text }) + "\n");
    });
  }
}
