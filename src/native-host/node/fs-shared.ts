// What fs and fs/promises share: Stats, Dirent, constants, argument normalisation and the async call.
import { Buffer } from "./buffer";
import { abortError } from "./signals";

export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0x0, O_WRONLY: 0x1, O_RDWR: 0x2, O_APPEND: 0x8, O_CREAT: 0x200, O_TRUNC: 0x400, O_EXCL: 0x800,
  O_NOFOLLOW: 0x100, O_SYNC: 0x80, O_DSYNC: 0x400000, O_NONBLOCK: 0x4, O_DIRECTORY: 0x100000, O_SYMLINK: 0x200000, O_NOCTTY: 0x20000,
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o40000, S_IFLNK: 0o120000,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  UV_FS_COPYFILE_EXCL: 1
};

type RawStats = Record<string, number | boolean>;
/** The file-type questions both Stats shapes answer from the host's flags. */
abstract class FileKind {
  protected abstract readonly kind: RawStats;
  isFile() { return Boolean(this.kind.isFile); }
  isDirectory() { return Boolean(this.kind.isDirectory); }
  isSymbolicLink() { return Boolean(this.kind.isSymbolicLink); }
  isFIFO() { return Boolean(this.kind.isFIFO); }
  isSocket() { return Boolean(this.kind.isSocket); }
  isBlockDevice() { return Boolean(this.kind.isBlockDevice); }
  isCharacterDevice() { return Boolean(this.kind.isCharacterDevice); }
}

export class Stats extends FileKind {
  dev = 0; ino = 0; mode = 0; nlink = 0; uid = 0; gid = 0; rdev = 0; size = 0; blksize = 0; blocks = 0;
  atimeMs = 0; mtimeMs = 0; ctimeMs = 0; birthtimeMs = 0;
  atime: Date; mtime: Date; ctime: Date; birthtime: Date;
  protected readonly kind: RawStats;
  constructor(raw: RawStats) {
    super();
    for (const key of ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks", "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs"] as const) this[key] = raw[key] as number;
    this.atime = new Date(this.atimeMs); this.mtime = new Date(this.mtimeMs); this.ctime = new Date(this.ctimeMs); this.birthtime = new Date(this.birthtimeMs);
    this.kind = raw;
  }
}

/** fs.Stats with { bigint: true }: every number a bigint, plus the nanosecond times (atimeNs …). */
export class BigIntStats extends FileKind {
  dev = 0n; ino = 0n; mode = 0n; nlink = 0n; uid = 0n; gid = 0n; rdev = 0n; size = 0n; blksize = 0n; blocks = 0n;
  atimeMs = 0n; mtimeMs = 0n; ctimeMs = 0n; birthtimeMs = 0n;
  atimeNs = 0n; mtimeNs = 0n; ctimeNs = 0n; birthtimeNs = 0n;
  atime: Date; mtime: Date; ctime: Date; birthtime: Date;
  protected readonly kind: RawStats;
  constructor(raw: RawStats) {
    super();
    for (const key of ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks"] as const) this[key] = BigInt(raw[key] as number);
    const times = (raw.times as unknown as number[] | undefined) ?? [];
    const names = ["atime", "mtime", "ctime", "birthtime"] as const;
    names.forEach((name, index) => {
      const seconds = BigInt(times[index * 2] ?? Math.floor((raw[`${name}Ms`] as number) / 1000));
      const nanos = BigInt(times[index * 2 + 1] ?? 0);
      this[`${name}Ns`] = seconds * 1_000_000_000n + nanos;
      this[`${name}Ms`] = this[`${name}Ns`] / 1_000_000n;
    });
    this.atime = new Date(Number(this.atimeMs)); this.mtime = new Date(Number(this.mtimeMs)); this.ctime = new Date(Number(this.ctimeMs)); this.birthtime = new Date(Number(this.birthtimeMs));
    this.kind = raw;
  }
}

export type StatOptions = { bigint?: boolean; throwIfNoEntry?: boolean };
/** Typed as Stats for the shims' signatures; callers that pass { bigint: true } are typed by @types/node. */
export function statsOf(raw: RawStats, options?: StatOptions): Stats {
  return (options?.bigint ? new BigIntStats(raw) : new Stats(raw)) as unknown as Stats;
}

export class Dirent {
  constructor(readonly name: string, private readonly type: string, readonly parentPath: string) {}
  get path() { return this.parentPath; }
  isFile() { return this.type === "file"; }
  isDirectory() { return this.type === "directory"; }
  isSymbolicLink() { return this.type === "symlink"; }
  isFIFO() { return false; }
  isSocket() { return false; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
}

export type PathLike = string | URL | Uint8Array;
export function pathOf(path: PathLike): string {
  if (typeof path === "string") return path;
  if (path instanceof URL) { if (path.protocol !== "file:") throw new TypeError("The URL must be of scheme file"); return decodeURIComponent(path.pathname); }
  if (path instanceof Uint8Array) return Buffer.from(path).toString("utf8");
  throw Object.assign(new TypeError(`The "path" argument must be of type string. Received ${typeof path}`), { code: "ERR_INVALID_ARG_TYPE" });
}

export type EncodingOption = string | { encoding?: string | null; flag?: string; mode?: number; signal?: AbortSignal } | null | undefined;
export function encodingOf(options: EncodingOption): string | null {
  if (typeof options === "string") return options;
  return options?.encoding ?? null;
}
export function dataOf(data: unknown, options?: EncodingOption): Uint8Array | string {
  if (typeof data === "string") {
    const encoding = encodingOf(options);
    return encoding && !/^utf-?8$/i.test(encoding) ? Buffer.from(data, encoding) : data;
  }
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw Object.assign(new TypeError(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.`), { code: "ERR_INVALID_ARG_TYPE" });
}
export function decoded(bytes: Uint8Array, options: EncodingOption): Buffer | string {
  const buffer = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const encoding = encodingOf(options);
  return encoding ? buffer.toString(encoding) : buffer;
}
/** Node's `mode` may be a number or an octal string. */
/** A file write's mode: the option, else 0o666. */
export function fileModeOf(options: EncodingOption): number {
  return typeof options === "object" ? modeOf(options?.mode, 0o666) : 0o666;
}
export function writeFlagOf(options: EncodingOption): string {
  return typeof options === "object" && options?.flag ? options.flag : "w";
}
export type MkdirOptions = number | string | { recursive?: boolean; mode?: number | string };
export function mkdirArgs(path: PathLike, options?: MkdirOptions): [string, boolean, number] {
  return [pathOf(path), typeof options === "object" && Boolean(options?.recursive), modeOf(typeof options === "object" ? options?.mode : options, 0o777)];
}
export function listingOf(dir: string, entries: { name: string; type: string }[], options?: string | { withFileTypes?: boolean }): string[] | Dirent[] {
  if (typeof options === "object" && options?.withFileTypes) return entries.map((entry) => new Dirent(entry.name, entry.type, dir));
  return entries.map((entry) => entry.name);
}
export function modeOf(mode: unknown, fallback: number): number {
  if (mode === undefined || mode === null) return fallback;
  return typeof mode === "string" ? Number.parseInt(mode, 8) : Number(mode);
}

/** Rebuilds the host error so it has a stack from here and Node's message shape. */
export function rethrow(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const source = error as unknown as Error & Record<string, unknown>;
    const copy = new Error(source.message) as Error & Record<string, unknown>;
    for (const key of ["code", "errno", "syscall", "path", "dest"]) if (source[key] !== undefined) copy[key] = source[key];
    throw copy;
  }
  throw error;
}

export function call<T>(op: string, args: unknown[], data: Uint8Array | string | null = null): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    __native.fsAsync(op, args, data, (error, result) => {
      if (error) { try { rethrow(error); } catch (copy) { reject(copy); } } else resolve(result as T);
    });
  });
}
export function callSync<T>(op: string, args: unknown[], data: Uint8Array | string | null = null): T {
  try { return __native.fsSync(op, args, data) as T; } catch (error) { rethrow(error); }
}

export function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}
