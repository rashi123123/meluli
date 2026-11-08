// Web and Node globals JavaScriptCore does not have (probed: no timers, URL, fetch, TextEncoder,
// AbortController, structuredClone, atob, crypto or performance). Imported first by the entry, so
// every module after it sees them.
import { Buffer } from "./node/buffer";
import { EventEmitter } from "./node/events";
import { SIGNAL_NUMBERS } from "./node/signals";
import { DOMException, Event, EventTarget, AbortController, AbortSignal } from "./web/abort";
import { URL, URLSearchParams } from "./web/url";
import { fetch, FormData, Headers, Request, Response, ReadableStream } from "./web/fetch";

const g = globalThis as Record<string, unknown>;

g.queueMicrotask = (callback: () => void) => { Promise.resolve().then(callback).catch(reportError); };
function reportError(error: unknown) {
  const text = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  __native.log("error", `Uncaught ${text}`);
}

// Timers. A Timeout object behaves like Node's: it converts to its id, and unref/ref are accepted
// (the host's run loop never exits on its own, so they change nothing).
class Timeout {
  constructor(public id: number, private readonly restart: () => number) {}
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
  refresh() { __native.clearTimer(this.id); this.id = this.restart(); return this; }
  close() { __native.clearTimer(this.id); return this; }
  [Symbol.toPrimitive]() { return this.id; }
}
const timers = new Map<number, Timeout>();
function schedule(callback: (...args: unknown[]) => void, ms: unknown, repeats: boolean, args: unknown[]): Timeout {
  const delay = Math.max(0, Number(ms) || 0);
  let timeout: Timeout;
  const start = () => __native.setTimer(delay, repeats, () => {
    if (!repeats) timers.delete(timeout.id);
    try { callback(...args); } catch (error) { reportError(error); }
  });
  timeout = new Timeout(start(), () => { timers.delete(timeout.id); const id = start(); timers.set(id, timeout); return id; });
  timers.set(timeout.id, timeout);
  return timeout;
}
function clear(handle: unknown) {
  if (handle === undefined || handle === null) return;
  const id = handle instanceof Timeout ? handle.id : Number(handle);
  __native.clearTimer(id);
  timers.delete(id);
}
g.setTimeout = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(callback, ms, false, args);
g.setInterval = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(callback, ms, true, args);
g.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => schedule(callback, 0, false, args);
g.clearTimeout = clear;
g.clearInterval = clear;
g.clearImmediate = clear;

// Console: one line per call, through the host's log.
function format(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
    try { return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item)) ?? String(value); }
    catch { return String(value); }
  }).join(" ");
}
g.console = {
  log: (...args: unknown[]) => __native.log("log", format(args)),
  info: (...args: unknown[]) => __native.log("info", format(args)),
  debug: (...args: unknown[]) => __native.log("debug", format(args)),
  warn: (...args: unknown[]) => __native.log("warn", format(args)),
  error: (...args: unknown[]) => __native.log("error", format(args)),
  trace: (...args: unknown[]) => __native.log("trace", `${format(args)}\n${new Error().stack ?? ""}`),
  time: () => undefined, timeEnd: () => undefined, table: (value: unknown) => __native.log("log", format([value]))
};

class TextEncoder {
  readonly encoding = "utf-8";
  encode(text = "") { return __native.utf8Encode(String(text)); }
  encodeInto(text: string, target: Uint8Array) { const bytes = __native.utf8Encode(text); const written = Math.min(bytes.length, target.length); target.set(bytes.subarray(0, written)); return { read: text.length, written }; }
}
class TextDecoder {
  readonly encoding: string;
  private pending = new Uint8Array(0);
  constructor(label = "utf-8", private readonly options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const name = label.toLowerCase();
    if (!["utf-8", "utf8", "unicode-1-1-utf-8"].includes(name)) throw new RangeError(`The "${label}" encoding is not supported`);
    this.encoding = "utf-8";
  }
  decode(input?: ArrayBuffer | ArrayBufferView, options: { stream?: boolean } = {}): string {
    let bytes = input === undefined ? new Uint8Array(0)
      : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (this.pending.length) { const joined = new Uint8Array(this.pending.length + bytes.length); joined.set(this.pending); joined.set(bytes, this.pending.length); bytes = joined; this.pending = new Uint8Array(0); }
    if (options.stream) {
      // Keep an unfinished UTF-8 sequence for the next call.
      let cut = bytes.length;
      for (let back = 1; back <= 3 && back <= bytes.length; back++) {
        const byte = bytes[bytes.length - back];
        if ((byte & 0xc0) === 0x80) continue;
        const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        if (needed > back) cut = bytes.length - back;
        break;
      }
      this.pending = bytes.slice(cut);
      bytes = bytes.subarray(0, cut);
    }
    let text = __native.utf8Decode(bytes);
    if (!this.options.ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }
}
g.TextEncoder = TextEncoder;
g.TextDecoder = TextDecoder;
g.atob = (text: string) => Buffer.from(String(text), "base64").toString("latin1");
g.btoa = (text: string) => Buffer.from(String(text), "latin1").toString("base64");
g.Buffer = Buffer;

const started = __native.hrtime();
g.performance = {
  now: () => (__native.hrtime() - started) / 1e6,
  timeOrigin: __native.now() - (__native.hrtime() - started) / 1e6,
  mark: () => undefined, measure: () => undefined, getEntriesByName: () => []
};
g.crypto = {
  randomUUID: () => __native.randomUUID(),
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    const bytes = __native.randomBytes(array.byteLength);
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  }
};

function clone(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") throw new DOMException(`${String(value)} could not be cloned.`, "DataCloneError");
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { constructor: new (buffer: ArrayBuffer) => unknown; buffer: ArrayBuffer; byteOffset: number; byteLength: number };
    const Constructor = value instanceof Buffer ? Uint8Array : view.constructor;
    return new (Constructor as new (buffer: ArrayBuffer) => unknown)(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (value instanceof Map) { const out = new Map(); seen.set(value, out); for (const [key, item] of value) out.set(clone(key, seen), clone(item, seen)); return out; }
  if (value instanceof Set) { const out = new Set(); seen.set(value, out); for (const item of value) out.add(clone(item, seen)); return out; }
  if (value instanceof Error) { const out = new (value.constructor as ErrorConstructor)(value.message); seen.set(value, out); out.name = value.name; out.stack = value.stack; return out; }
  const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  for (const key of Object.keys(value)) (out as Record<string, unknown>)[key] = clone((value as Record<string, unknown>)[key], seen);
  return out;
}
g.structuredClone = (value: unknown) => clone(value, new Map());

Object.assign(g, { DOMException, Event, EventTarget, AbortController, AbortSignal, URL, URLSearchParams, fetch, FormData, Headers, Request, Response, ReadableStream });
g.__isBigInt = (value: unknown) => typeof value === "bigint";

// process: what the main-process code reads, plus the events it subscribes to.
const processEvents = new EventEmitter();
const stream = (level: string) => Object.assign(new EventEmitter(), {
  write: (chunk: unknown) => { __native.log(level, String(chunk).replace(/\n$/, "")); return true; },
  isTTY: false
});
const hrtime = Object.assign((previous?: [number, number]) => {
  const now = __native.hrtime();
  const seconds = Math.floor(now / 1e9), nanos = Math.floor(now % 1e9);
  if (!previous) return [seconds, nanos];
  let s = seconds - previous[0], n = nanos - previous[1];
  if (n < 0) { s -= 1; n += 1e9; }
  return [s, n];
}, { bigint: () => BigInt(Math.floor(__native.hrtime())) });
/** The launch environment. MELULI_NATIVE_DEVELOPMENT marks a development build and is never inherited. */
function hostEnvironment(): Record<string, string | undefined> {
  const environment = __native.environment();
  delete environment.MELULI_NATIVE_DEVELOPMENT;
  if (__native.isDevelopmentBuild === true) environment.MELULI_NATIVE_DEVELOPMENT = "1";
  return environment;
}
const processObject = Object.assign(processEvents, {
  env: hostEnvironment(),
  platform: "darwin",
  arch: "arm64",
  type: "browser",
  pid: __native.pid,
  ppid: 1,
  argv: __native.arguments,
  argv0: __native.arguments[0],
  execArgv: [] as string[],
  execPath: __native.arguments[0],
  versions: { node: "22.0.0", v8: "0", meluliNative: "1" } as Record<string, string>,
  version: "v22.0.0",
  release: { name: "node" },
  resourcesPath: __native.resourcesPath ?? "",
  exitCode: undefined as number | undefined,
  stdout: stream("stdout"),
  stderr: stream("stderr"),
  cwd: () => __native.cwd(),
  chdir: () => { throw new Error("process.chdir is not available in the native host"); },
  umask: () => 0o022,
  uptime: () => (__native.hrtime() - started) / 1e9,
  hrtime,
  cpuUsage: () => __native.cpuUsage(),
  memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
  getSystemVersion: () => __native.systemVersion,
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => { (g.queueMicrotask as (cb: () => void) => void)(() => callback(...args)); },
  emitWarning: (warning: unknown) => __native.log("warn", String(warning instanceof Error ? warning.message : warning)),
  exit: (code?: number) => {
    processEvents.emit("exit", code ?? processObject.exitCode ?? 0);
    __native.exit(code ?? processObject.exitCode ?? 0);
  },
  kill: (pid: number, signal: string | number = "SIGTERM") => {
    const number = typeof signal === "number" ? signal : SIGNAL_NUMBERS[signal];
    if (number === undefined) throw new TypeError(`Unknown signal: ${String(signal)}`);
    return __native.kill(pid, number);
  }
});
g.process = processObject;
