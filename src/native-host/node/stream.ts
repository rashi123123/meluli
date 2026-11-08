// The part of Node streams the app touches: readable child-process output and file reads (`data`,
// `end`, `close`, pause/resume, async iteration) and writable child-process input.
import { EventEmitter } from "./events";
import { Buffer } from "./buffer";

export class Readable extends EventEmitter {
  readable = true;
  readableEnded = false;
  destroyed = false;
  private buffered: (Buffer | string)[] = [];
  protected flowing: boolean | null = null;
  private ended = false;
  private encoding: string | null = null;
  /** Called when the consumer wants more after a pause (file streams read the next chunk). */
  protected _read(): void {}
  /** Called when the stream is destroyed early (file streams close, processes ignore). */
  protected _destroy(_error: Error | null, done: (error?: Error | null) => void): void { done(null); }

  constructor() {
    super();
    // Attaching a `data` listener starts the flow, as in Node.
    this.on("newListener", (event: string) => {
      if (event === "data" && this.flowing !== false) queueMicrotask(() => this.resume());
    });
  }

  setEncoding(encoding: string) { this.encoding = encoding; return this; }
  isPaused() { return this.flowing === false; }

  push(chunk: Buffer | Uint8Array | string | null): boolean {
    if (this.destroyed) return false;
    if (chunk === null) { this.ended = true; this.drain(); return false; }
    const value = typeof chunk === "string" ? chunk
      : this.encoding ? Buffer.from(chunk).toString(this.encoding) : chunk instanceof Buffer ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.flowing && this.buffered.length === 0) this.emit("data", value);
    else this.buffered.push(value);
    return this.flowing === true;
  }

  private drain() {
    while (this.flowing && this.buffered.length) this.emit("data", this.buffered.shift()!);
    if (this.ended && this.buffered.length === 0 && !this.readableEnded && this.flowing !== false) {
      this.readableEnded = true;
      this.readable = false;
      queueMicrotask(() => { this.emit("end"); this.emit("close"); });
    }
  }

  resume() {
    if (this.flowing === true) return this;
    this.flowing = true;
    this.emit("resume");
    this.drain();
    if (!this.ended) this._read();
    return this;
  }
  pause() { if (this.flowing !== false) { this.flowing = false; this.emit("pause"); } return this; }
  read(): Buffer | string | null {
    const chunk = this.buffered.shift() ?? null;
    if (!this.buffered.length) { if (this.ended) this.drain(); else this._read(); }
    return chunk;
  }
  pipe<T extends { write(chunk: unknown): unknown; end(): unknown }>(target: T): T {
    this.on("data", (chunk) => target.write(chunk));
    this.once("end", () => target.end());
    return target;
  }
  unpipe() { return this; }

  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.buffered = [];
    this._destroy(error ?? null, (failure) => {
      queueMicrotask(() => { if (failure ?? error) this.emit("error", failure ?? error); this.emit("close"); });
    });
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {
    const queue: (Buffer | string)[] = [];
    let done = false;
    let failure: unknown = null;
    let wake: (() => void) | null = null;
    const notify = () => { const next = wake; wake = null; next?.(); };
    const onData = (chunk: Buffer | string) => { queue.push(chunk); this.pause(); notify(); };
    const onEnd = () => { done = true; notify(); };
    const onError = (error: unknown) => { failure = error; done = true; notify(); };
    this.on("data", onData);
    this.once("end", onEnd);
    this.once("close", onEnd);
    this.once("error", onError);
    try {
      while (true) {
        if (queue.length) { yield queue.shift()!; if (!queue.length && !done) this.resume(); continue; }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      this.off("data", onData); this.off("end", onEnd); this.off("close", onEnd); this.off("error", onError);
      if (!this.readableEnded) this.destroy();
    }
  }
}

export class Writable extends EventEmitter {
  writable = true;
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  constructor(private readonly sink: { write(chunk: Uint8Array): boolean; end(): void } = { write: () => true, end: () => undefined }) { super(); }
  write(chunk: unknown, encoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    const done = typeof encoding === "function" ? encoding : callback;
    if (this.writableEnded || this.destroyed) {
      const error = Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      queueMicrotask(() => { done?.(error); this.emit("error", error); });
      return false;
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : chunk as Uint8Array;
    const ok = this.sink.write(bytes);
    queueMicrotask(() => done?.(ok ? null : new Error("write failed")));
    return true;
  }
  end(chunk?: unknown, encoding?: string | (() => void), callback?: () => void): this {
    const done = typeof chunk === "function" ? chunk as () => void : typeof encoding === "function" ? encoding : callback;
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") this.write(chunk, typeof encoding === "string" ? encoding : undefined);
    if (!this.writableEnded) {
      this.writableEnded = true;
      this.writable = false;
      this.sink.end();
      queueMicrotask(() => { this.writableFinished = true; this.emit("finish"); done?.(); this.emit("close"); });
    }
    return this;
  }
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (!this.writableEnded) { this.writableEnded = true; this.sink.end(); }
    queueMicrotask(() => { if (error) this.emit("error", error); this.emit("close"); });
    return this;
  }
  cork() {}
  uncork() {}
  setDefaultEncoding() { return this; }
}

export class PassThrough extends Readable {
  write(chunk: Uint8Array | string) { this.push(chunk); return true; }
  end(chunk?: Uint8Array | string) { if (chunk !== undefined) this.push(chunk); this.push(null); return this; }
}

export default { Readable, Writable, PassThrough };
