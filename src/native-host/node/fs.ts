// fs: the synchronous calls the app makes at start-up and in its journals, createReadStream for
// hashing downloads, and `promises`.
import { Buffer } from "./buffer";
import { callSync, call, constants, dataOf, decoded, Dirent, fileModeOf, listingOf, mkdirArgs, modeOf, pathOf, writeFlagOf, type MkdirOptions, Stats, statsOf, type EncodingOption, type StatOptions, type PathLike } from "./fs-shared";
import * as promises from "./fs-promises";
import { Readable } from "./stream";
import { abortError } from "./signals";

export function existsSync(path: PathLike): boolean { try { return Boolean(__native.fsSync("exists", [pathOf(path)], null)); } catch { return false; } }
export function accessSync(path: PathLike, mode = constants.F_OK) { callSync("access", [pathOf(path), mode]); }
export function statSync(path: PathLike, options?: StatOptions): Stats | undefined {
  try { return statsOf(callSync("stat", [pathOf(path)]), options); }
  catch (error) { if (options?.throwIfNoEntry === false && (error as { code?: string }).code === "ENOENT") return undefined; throw error; }
}
export function lstatSync(path: PathLike, options?: StatOptions): Stats { return statsOf(callSync("lstat", [pathOf(path)]), options); }
export function fstatSync(fd: number, options?: StatOptions): Stats { return statsOf(callSync("fstat", [fd]), options); }
export function readFileSync(path: PathLike | number, options?: EncodingOption): Buffer | string {
  if (typeof path === "number") {
    const parts: Uint8Array[] = [];
    while (true) { const chunk = callSync<Uint8Array>("read", [path, 1 << 20, -1]); if (!chunk.byteLength) break; parts.push(chunk); }
    return decoded(Buffer.concat(parts), options);
  }
  return decoded(callSync<Uint8Array>("readFile", [pathOf(path)]), options);
}
export function writeFileSync(path: PathLike | number, data: unknown, options?: EncodingOption) {
  if (typeof path === "number") { callSync("write", [path, -1], dataOf(data, options)); return; }
  callSync("writeFile", [pathOf(path), writeFlagOf(options), fileModeOf(options)], dataOf(data, options));
}
export function appendFileSync(path: PathLike, data: unknown, options?: EncodingOption) {
  callSync("writeFile", [pathOf(path), "a", fileModeOf(options)], dataOf(data, options));
}
export function mkdirSync(path: PathLike, options?: MkdirOptions): string | undefined {
  const args = mkdirArgs(path, options);
  const first = callSync<string | undefined>("mkdir", args);
  return args[1] ? first ?? undefined : undefined;
}
export function readdirSync(path: PathLike, options?: string | { withFileTypes?: boolean }): string[] | Dirent[] {
  const dir = pathOf(path);
  return listingOf(dir, callSync<{ name: string; type: string }[]>("readdir", [dir]), options);
}
export function renameSync(from: PathLike, to: PathLike) { callSync("rename", [pathOf(from), pathOf(to)]); }
export function unlinkSync(path: PathLike) { callSync("unlink", [pathOf(path)]); }
export function rmdirSync(path: PathLike) { callSync("rmdir", [pathOf(path)]); }
export function rmSync(path: PathLike, options?: { recursive?: boolean; force?: boolean }) {
  callSync("rm", [pathOf(path), Boolean(options?.recursive), Boolean(options?.force)]);
}
export function realpathSync(path: PathLike): string { return callSync<string>("realpath", [pathOf(path)]); }
realpathSync.native = realpathSync;
export function mkdtempSync(prefix: string): string { return callSync<string>("mkdtemp", [prefix]); }
export function copyFileSync(from: PathLike, to: PathLike, mode = 0) { callSync("copyFile", [pathOf(from), pathOf(to), mode]); }
export function chmodSync(path: PathLike, mode: number | string) { callSync("chmod", [pathOf(path), modeOf(mode, 0o644)]); }
export function openSync(path: PathLike, flags: string | number = "r", mode?: number | string): number {
  return callSync<number>("open", [pathOf(path), flags, modeOf(mode, 0o666)]);
}
export function closeSync(fd: number) { callSync("close", [fd]); }
export function fsyncSync(fd: number) { callSync("fsync", [fd]); }
export function ftruncateSync(fd: number, length = 0) { callSync("ftruncate", [fd, length]); }
export function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position: number | null = null): number {
  const bytes = callSync<Uint8Array>("read", [fd, length, position ?? -1]);
  buffer.set(bytes, offset);
  return bytes.byteLength;
}
export function writeSync(fd: number, data: Uint8Array | string, offset?: number | null, length?: number, position?: number | null): number {
  if (typeof data === "string") return callSync<number>("write", [fd, offset ?? -1], data);
  const start = offset ?? 0;
  return callSync<number>("write", [fd, position ?? -1], data.subarray(start, start + (length ?? data.byteLength - start)));
}

class ReadStream extends Readable {
  private fd: number | null = null;
  private position: number;
  private reading = false;
  bytesRead = 0;
  constructor(readonly path: string, private readonly options: { highWaterMark?: number; start?: number; end?: number; signal?: AbortSignal; encoding?: string } = {}) {
    super();
    this.position = options.start ?? 0;
    if (options.encoding) this.setEncoding(options.encoding);
    const signal = options.signal;
    if (signal?.aborted) { queueMicrotask(() => this.destroy(abortError(signal))); return; }
    signal?.addEventListener("abort", () => this.destroy(abortError(signal)), { once: true });
    call<number>("open", [path, "r", 0o666]).then((fd) => {
      if (this.destroyed) { void call("close", [fd]).catch(() => undefined); return; }
      this.fd = fd;
      this.emit("open", fd);
      this.emit("ready");
      if (this.flowing === true) this._read();
    }, (error) => this.destroy(error));
  }
  protected override _read() {
    if (this.fd === null || this.reading || this.destroyed || this.flowing !== true) return;
    this.reading = true;
    const limit = this.options.end === undefined ? Infinity : this.options.end + 1 - this.position;
    const size = Math.min(this.options.highWaterMark ?? 65536, limit);
    if (size <= 0) { this.reading = false; this.finish(); return; }
    call<Uint8Array>("read", [this.fd, size, this.position]).then((bytes) => {
      this.reading = false;
      if (this.destroyed) return;
      if (!bytes.byteLength) { this.finish(); return; }
      this.position += bytes.byteLength;
      this.bytesRead += bytes.byteLength;
      this.push(bytes);
      if (this.flowing === true) this._read();
    }, (error) => { this.reading = false; this.destroy(error); });
  }
  private finish() {
    const fd = this.fd; this.fd = null;
    if (fd !== null) void call("close", [fd]).catch(() => undefined);
    this.push(null);
  }
  protected override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    const fd = this.fd; this.fd = null;
    if (fd === null) { done(error); return; }
    call("close", [fd]).then(() => done(error), () => done(error));
  }
  close(callback?: () => void) { this.destroy(); if (callback) this.once("close", callback); }
}
export function createReadStream(path: PathLike, options?: string | { highWaterMark?: number; start?: number; end?: number; signal?: AbortSignal; encoding?: string }) {
  return new ReadStream(pathOf(path), typeof options === "string" ? { encoding: options } : options);
}

export { constants, promises, Stats, Dirent };
export default {
  existsSync, accessSync, statSync, lstatSync, fstatSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, renameSync,
  unlinkSync, rmdirSync, rmSync, realpathSync, mkdtempSync, copyFileSync, chmodSync, openSync, closeSync, fsyncSync, ftruncateSync,
  readSync, writeSync, createReadStream, constants, promises, Stats, Dirent
};
