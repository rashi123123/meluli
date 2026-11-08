// worker_threads, inline. The app's one worker (the WAV encoder in recording-wav.ts) is a short
// pure function; it runs on the JS thread in its own scope with its own `parentPort`, after the
// current turn, so the caller's message-and-terminate protocol is unchanged.
import { EventEmitter } from "./events";
import { Buffer } from "./buffer";

export const isMainThread = true;
export const threadId = 0;
export let parentPort: EventEmitter | null = null;
export const workerData = undefined;

class Port extends EventEmitter {
  constructor(private readonly deliver: (message: unknown) => void) { super(); }
  postMessage(message: unknown) { const copy = message; queueMicrotask(() => this.deliver(copy)); }
  close() { this.removeAllListeners(); }
  ref() {} unref() {}
}

export class Worker extends EventEmitter {
  readonly threadId = 1;
  private inner: Port;
  private terminated = false;
  constructor(source: string, options: { eval?: boolean; workerData?: unknown } = {}) {
    super();
    if (!options.eval) throw new Error("Only eval workers are available in the native host");
    this.inner = new Port((message) => { if (!this.terminated) this.emit("message", message); });
    const port = this.inner;
    const requireForWorker = (name: string) => {
      if (name === "node:worker_threads" || name === "worker_threads") return { parentPort: port, isMainThread: false, workerData: options.workerData, threadId: 1 };
      if (name === "node:buffer" || name === "buffer") return { Buffer };
      throw new Error(`Cannot find module '${name}' in an inline worker`);
    };
    queueMicrotask(() => {
      try {
        new Function("require", "Buffer", source)(requireForWorker, Buffer);
        this.emit("online");
      } catch (error) { this.emit("error", error); this.emit("exit", 1); }
    });
  }
  postMessage(message: unknown) {
    if (this.terminated) return;
    const copy = message;
    queueMicrotask(() => { if (!this.terminated) this.inner.emit("message", copy); });
  }
  terminate(): Promise<number> {
    if (!this.terminated) { this.terminated = true; this.inner.close(); queueMicrotask(() => this.emit("exit", 1)); }
    return Promise.resolve(1);
  }
  ref() {} unref() {}
}
export default { Worker, isMainThread, parentPort, workerData, threadId };
