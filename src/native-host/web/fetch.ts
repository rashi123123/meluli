// fetch over the host's URLSession (HostFetch.swift): Headers, Request, Response and a small
// ReadableStream. The body streams; each chunk taken is reported back so the transfer resumes.
import { abortedReason, AbortSignal } from "./abort";

type Chunk = Uint8Array;
interface Source { start?(controller: Controller): void; pull?(controller: Controller): void | Promise<void>; cancel?(reason?: unknown): void | Promise<void> }
interface Controller { enqueue(chunk: Chunk): void; close(): void; error(error: unknown): void; desiredSize: number }

export class ReadableStream {
  private queue: Chunk[] = [];
  private closed = false;
  private failure: unknown = null;
  private waiting: { resolve: (result: { done: boolean; value?: Chunk }) => void; reject: (error: unknown) => void }[] = [];
  private pulling = false;
  private markClosed: () => void = () => {};
  /** Settles once the stream ends, by close, cancel or error; a reader's `closed` (never rejects here). */
  private readonly whenClosed = new Promise<void>((resolve) => { this.markClosed = resolve; });
  locked = false;
  /** @internal */ _onTake?: (chunk: Chunk) => void;
  private readonly controller: Controller;

  constructor(private readonly source: Source = {}) {
    this.controller = {
      enqueue: (chunk) => this.push(chunk),
      close: () => this.finish(),
      error: (error) => this.fail(error),
      get desiredSize() { return 1; }
    };
    source.start?.(this.controller);
  }

  /** @internal */ push(chunk: Chunk) {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) { this._onTake?.(chunk); waiter.resolve({ done: false, value: chunk }); } else this.queue.push(chunk);
  }
  /** @internal */ finish() {
    this.closed = true;
    this.markClosed();
    for (const waiter of this.waiting.splice(0)) waiter.resolve({ done: true });
  }
  /** @internal */ fail(error: unknown) {
    this.failure = error ?? new Error("stream failed");
    this.closed = true;
    this.markClosed();
    for (const waiter of this.waiting.splice(0)) waiter.reject(this.failure);
  }

  private read(): Promise<{ done: boolean; value?: Chunk }> {
    const chunk = this.queue.shift();
    if (chunk) { this._onTake?.(chunk); return Promise.resolve({ done: false, value: chunk }); }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true });
    const pending = new Promise<{ done: boolean; value?: Chunk }>((resolve, reject) => this.waiting.push({ resolve, reject }));
    if (this.source.pull && !this.pulling) {
      this.pulling = true;
      Promise.resolve(this.source.pull(this.controller)).catch((error) => this.fail(error)).finally(() => { this.pulling = false; });
    }
    return pending;
  }

  getReader() {
    this.locked = true;
    return {
      read: () => this.read(),
      cancel: (reason?: unknown) => this.cancel(reason),
      releaseLock: () => { this.locked = false; },
      closed: this.whenClosed
    };
  }
  async cancel(reason?: unknown) {
    this.queue = [];
    this.finish();
    await this.source.cancel?.(reason);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Chunk> {
    try {
      while (true) { const { done, value } = await this.read(); if (done) return; yield value!; }
    } finally { if (!this.closed) await this.cancel(); }
  }
  tee(): [ReadableStream, ReadableStream] {
    const branches: ReadableStream[] = [];
    let reading = false;
    const pump = async () => {
      if (reading) return;
      reading = true;
      try {
        const { done, value } = await this.read();
        for (const branch of branches) { if (done) branch.finish(); else branch.push(value!); }
      } catch (error) { for (const branch of branches) branch.fail(error); }
      finally { reading = false; }
    };
    for (let index = 0; index < 2; index++) branches.push(new ReadableStream({ pull: pump, cancel: () => undefined }));
    return branches as [ReadableStream, ReadableStream];
  }
}

export class Headers {
  private map = new Map<string, string>();
  constructor(init?: Headers | Record<string, string> | [string, string][]) {
    if (init instanceof Headers) init.forEach((value, key) => this.append(key, value));
    else if (Array.isArray(init)) for (const [key, value] of init) this.append(key, value);
    else if (init) for (const [key, value] of Object.entries(init)) if (value !== undefined) this.append(key, String(value));
  }
  append(name: string, value: string) { const key = name.toLowerCase(); const old = this.map.get(key); this.map.set(key, old === undefined ? String(value) : `${old}, ${value}`); }
  set(name: string, value: string) { this.map.set(name.toLowerCase(), String(value)); }
  get(name: string) { return this.map.get(name.toLowerCase()) ?? null; }
  has(name: string) { return this.map.has(name.toLowerCase()); }
  delete(name: string) { this.map.delete(name.toLowerCase()); }
  forEach(callback: (value: string, key: string, parent: Headers) => void) { for (const [key, value] of this.map) callback(value, key, this); }
  getSetCookie() { const value = this.get("set-cookie"); return value ? [value] : []; }
  keys() { return this.map.keys(); }
  values() { return this.map.values(); }
  entries() { return this.map.entries(); }
  [Symbol.iterator]() { return this.map.entries(); }
}

async function collect(stream: ReadableStream | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) { parts.push(chunk); total += chunk.byteLength; }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function bodyBytes(body: unknown): Uint8Array | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return __native.utf8Encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return __native.utf8Encode(body.toString());
  throw new TypeError("This request body type is not supported in the native host");
}

export class Response {
  readonly headers: Headers;
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly url: string;
  readonly redirected = false;
  readonly type = "basic";
  body: ReadableStream | null;
  bodyUsed = false;

  constructor(body?: ReadableStream | Uint8Array | string | null, init: { status?: number; statusText?: string; headers?: Headers | Record<string, string> | [string, string][]; url?: string } = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    this.url = init.url ?? "";
    if (body instanceof ReadableStream || body === null || body === undefined) this.body = body ?? null;
    else { const bytes = bodyBytes(body)!; this.body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); }
  }
  private take(): ReadableStream | null {
    if (this.bodyUsed) throw new TypeError("Body has already been consumed.");
    this.bodyUsed = true;
    return this.body;
  }
  async arrayBuffer(): Promise<ArrayBuffer> { const bytes = await collect(this.take()); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
  async bytes(): Promise<Uint8Array> { return collect(this.take()); }
  async text(): Promise<string> { return __native.utf8Decode(await collect(this.take())); }
  async json(): Promise<unknown> { return JSON.parse(await this.text()); }
  async blob(): Promise<never> { throw new TypeError("Blob bodies are not supported in the native host"); }
  clone(): Response {
    if (this.bodyUsed) throw new TypeError("Response body is already used");
    let other: ReadableStream | null = null;
    if (this.body) { const [a, b] = this.body.tee(); this.body = a; other = b; }
    return new Response(other, { status: this.status, statusText: this.statusText, headers: new Headers(this.headers), url: this.url });
  }
  static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
    return new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  }
  static error() { return new Response(null, { status: 0 }); }
}

export class Request {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal | null;
  readonly redirect: string;
  constructor(input: string | URL | Request, init: RequestInit = {}) {
    const base = input instanceof Request ? input : null;
    this.url = base ? base.url : String(input);
    this.method = (init.method ?? base?.method ?? "GET").toUpperCase();
    this.headers = new Headers((init.headers as Record<string, string>) ?? base?.headers);
    this.body = init.body ?? base?.body ?? null;
    this.signal = (init.signal as AbortSignal | undefined) ?? base?.signal ?? null;
    this.redirect = init.redirect ?? base?.redirect ?? "follow";
  }
}

interface RequestInit { method?: string; headers?: unknown; body?: unknown; signal?: unknown; redirect?: string; credentials?: string; [key: string]: unknown }

/** Names the type so `instanceof FormData` checks (the Anthropic SDK's body check) work; multipart bodies are not supported. */
export class FormData {
  constructor() { throw new TypeError("FormData is not supported in the native host"); }
}

export function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const request = new Request(input, init);
  const signal = request.signal;
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortedReason());
  const headers: [string, string][] = [];
  request.headers.forEach((value, key) => headers.push([key, value]));
  let body: Uint8Array | null;
  try { body = bodyBytes(request.body); } catch (error) { return Promise.reject(error); }
  return new Promise<Response>((resolve, reject) => {
    let stream: ReadableStream | null = null;
    let settled = false;
    let id = 0;
    const onAbort = () => {
      __native.fetchCancel(id);
      const reason = signal?.reason ?? abortedReason();
      if (!settled) { settled = true; reject(reason); } else stream?.fail(reason);
    };
    id = __native.fetch({ url: request.url, method: request.method, headers, body, redirect: request.redirect }, (event: string, ...args: any[]) => {
      switch (event) {
        case "response": {
          const [status, list, url] = args as [number, [string, string][], string];
          stream = new ReadableStream({ cancel: () => { __native.fetchCancel(id); signal?.removeEventListener("abort", onAbort); } });
          stream._onTake = (chunk) => __native.fetchConsumed(id, chunk.byteLength);
          settled = true;
          resolve(new Response(stream, { status, headers: list, url }));
          break;
        }
        case "data": stream?.push(args[0] as Uint8Array); break;
        case "end": signal?.removeEventListener("abort", onAbort); stream?.finish(); break;
        case "error": {
          signal?.removeEventListener("abort", onAbort);
          const error = Object.assign(new TypeError("fetch failed"), { cause: new Error(String(args[0])) });
          if (!settled) { settled = true; reject(error); } else stream?.fail(error);
          break;
        }
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
