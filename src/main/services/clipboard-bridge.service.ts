import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pipelineTrace } from "../pipeline-trace";

export interface ClipboardLease { restore(): Promise<void>; quarantine?(): Promise<void> }

/** Native pasteboard items preserve all formats; its change counter protects new copies. */
export class ClipboardBridgeService {
  constructor(private readonly executable: string) {}

  begin(text: string): Promise<ClipboardLease> {
    return new Promise((resolve, reject) => {
      pipelineTrace("clipboard_begin", "start");
      const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "ignore"] });
      const lines = createInterface({ input: child.stdout });
      let ready = false;
      let expired = false;
      let startupFailure: Error | null = null;
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
        if (!ready) reject(startupFailure ?? new Error("Clipboard helper unavailable."));
      };
      const restore = (): Promise<void> => {
        if (closed) return Promise.resolve();
        if (restoration) return restoration;
        restoration = new Promise<void>(done => {
          pipelineTrace("clipboard_restore", "start");
          finish = () => { pipelineTrace("clipboard_restore", "end"); done(); };
          child.stdin.end();
          // The helper has its own 8s restoration deadline. Allow it to finish,
          // but never let an unresponsive child hold the dictation queue forever.
          terminateTimer = setTimeout(() => {
            if (closed) return;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              if (!closed) child.kill("SIGKILL");
              close();
            }, 1_000);
            killTimer.unref();
          }, 10_000);
          terminateTimer.unref();
        });
        return restoration;
      };
      const failStartup = (message: string) => {
        if (ready || expired) return;
        expired = true;
        pipelineTrace("clipboard_begin", "failed", { reason: message });
        startupFailure = new Error(message);
        clearTimeout(readyTimer);
        // Keep the insertion pending until the previous helper has restored or
        // exited. Otherwise another dictation can snapshot its temporary text.
        void restore().then(() => reject(startupFailure));
      };
      const readyTimer = setTimeout(() => {
        failStartup("Clipboard helper did not become ready.");
      }, 3_000);
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
          // Keep the exact paste payload until the existing native 8s watchdog
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
              killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); close(); }, 1000);
            }, 10000);
          });
          return restoration;
        } });
      });
      // Pipe only: text is never placed in process arguments, a file or logs.
      child.stdin.write(JSON.stringify({ text }) + "\n");
    });
  }
}
