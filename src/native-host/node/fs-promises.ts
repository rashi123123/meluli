// fs/promises over the host's POSIX calls. Every call runs off the JS thread.
import { Buffer } from "./buffer";
import { call, checkAborted, constants, dataOf, decoded, Dirent, fileModeOf, listingOf, mkdirArgs, modeOf, pathOf, writeFlagOf, type MkdirOptions, Stats, statsOf, type EncodingOption, type StatOptions, type PathLike } from "./fs-shared";

export class FileHandle {
  private closed = false;
  constructor(readonly fd: number) {}
  private live() { if (this.closed) throw Object.assign(new Error("file closed"), { code: "EBADF", syscall: "read" }); }

  async read<T extends Uint8Array>(buffer?: T | { buffer?: T; offset?: number; length?: number; position?: number | null }, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: T }> {
    this.live();
    let target: T;
    if (buffer && !(buffer instanceof Uint8Array)) {
      const options = buffer;
      target = (options.buffer ?? Buffer.alloc(16384)) as T;
      offset = options.offset; length = options.length; position = options.position;
    } else target = (buffer ?? Buffer.alloc(16384)) as T;
    const start = offset ?? 0;
    const count = length ?? target.byteLength - start;
    const bytes = await call<Uint8Array>("read", [this.fd, count, position ?? -1]);
    target.set(bytes, start);
    return { bytesRead: bytes.byteLength, buffer: target };
  }
  async write(data: Uint8Array | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | string, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array | string }> {
    this.live();
    if (typeof data === "string") {
      const bytes = Buffer.from(data, typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8");
      const written = await call<number>("write", [this.fd, offsetOrPosition ?? -1], bytes);
      return { bytesWritten: written, buffer: data };
    }
    const offset = offsetOrPosition ?? 0;
    const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : data.byteLength - offset;
    const slice = data.subarray(offset, offset + length);
    const written = await call<number>("write", [this.fd, position ?? -1], slice);
    return { bytesWritten: written, buffer: data };
  }
  async writeFile(data: Uint8Array | string, options?: EncodingOption) {
    this.live();
    const value = dataOf(data, options);
    await call("write", [this.fd, -1], value);
  }
  async appendFile(data: Uint8Array | string, options?: EncodingOption) { return this.writeFile(data, options); }
  async readFile(options?: EncodingOption): Promise<Buffer | string> {
    this.live();
    const parts: Uint8Array[] = [];
    while (true) {
      const chunk = await call<Uint8Array>("read", [this.fd, 1 << 20, -1]);
      if (!chunk.byteLength) break;
      parts.push(chunk);
    }
    return decoded(Buffer.concat(parts), options);
  }
  async stat(options?: StatOptions): Promise<Stats> { this.live(); return statsOf(await call("fstat", [this.fd]), options); }
  async chmod(mode: number | string) { this.live(); await call("fchmod", [this.fd, modeOf(mode, 0o644)]); }
  async sync() { this.live(); await call("fsync", [this.fd]); }
  async datasync() { return this.sync(); }
  async truncate(length = 0) { this.live(); await call("ftruncate", [this.fd, length]); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await call("close", [this.fd]);
  }
  async [Symbol.asyncDispose]() { await this.close(); }
}

export async function open(path: PathLike, flags: string | number = "r", mode?: number | string): Promise<FileHandle> {
  return new FileHandle(await call<number>("open", [pathOf(path), flags, modeOf(mode, 0o666)]));
}
export async function readFile(path: PathLike | FileHandle, options?: EncodingOption): Promise<Buffer | string> {
  if (path instanceof FileHandle) return path.readFile(options);
  checkAborted(typeof options === "object" ? options?.signal : undefined);
  return decoded(await call<Uint8Array>("readFile", [pathOf(path)]), options);
}
export async function writeFile(path: PathLike | FileHandle, data: unknown, options?: EncodingOption) {
  if (path instanceof FileHandle) return path.writeFile(data as Uint8Array | string, options);
  const signal = typeof options === "object" ? options?.signal : undefined;
  checkAborted(signal);
  await call("writeFile", [pathOf(path), writeFlagOf(options), fileModeOf(options)], dataOf(data, options));
  // The write itself is one host call and is not interrupted; a cancel during it is reported after.
  checkAborted(signal);
}
export async function appendFile(path: PathLike, data: unknown, options?: EncodingOption) {
  await call("writeFile", [pathOf(path), "a", fileModeOf(options)], dataOf(data, options));
}
export async function mkdir(path: PathLike, options?: MkdirOptions): Promise<string | undefined> {
  const args = mkdirArgs(path, options);
  const first = await call<string | undefined>("mkdir", args);
  return args[1] ? first ?? undefined : undefined;
}
export async function readdir(path: PathLike, options?: string | { withFileTypes?: boolean; encoding?: string }): Promise<string[] | Dirent[]> {
  const dir = pathOf(path);
  return listingOf(dir, await call<{ name: string; type: string }[]>("readdir", [dir]), options);
}
export async function stat(path: PathLike, options?: StatOptions): Promise<Stats> { return statsOf(await call("stat", [pathOf(path)]), options); }
export async function lstat(path: PathLike, options?: StatOptions): Promise<Stats> { return statsOf(await call("lstat", [pathOf(path)]), options); }
export async function statfs(path: PathLike) { return call<Record<string, number>>("statfs", [pathOf(path)]); }
export async function access(path: PathLike, mode = constants.F_OK) { await call("access", [pathOf(path), mode]); }
export async function rename(from: PathLike, to: PathLike) { await call("rename", [pathOf(from), pathOf(to)]); }
export async function unlink(path: PathLike) { await call("unlink", [pathOf(path)]); }
export async function rmdir(path: PathLike) { await call("rmdir", [pathOf(path)]); }
export async function rm(path: PathLike, options?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }) {
  // As Node: EBUSY, ENOTEMPTY and EPERM are retried with a linear backoff, maxRetries times.
  const retries = Math.max(0, options?.maxRetries ?? 0);
  for (let attempt = 0; ; attempt += 1) {
    try { return void await call("rm", [pathOf(path), Boolean(options?.recursive), Boolean(options?.force)]); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= retries || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, (options?.retryDelay ?? 100) * (attempt + 1)));
    }
  }
}
export async function realpath(path: PathLike, _options?: EncodingOption) { return call<string>("realpath", [pathOf(path)]); }
export async function mkdtemp(prefix: string) { return call<string>("mkdtemp", [prefix]); }
export async function copyFile(from: PathLike, to: PathLike, mode = 0) { await call("copyFile", [pathOf(from), pathOf(to), mode]); }
export async function chmod(path: PathLike, mode: number | string) { await call("chmod", [pathOf(path), modeOf(mode, 0o644)]); }
export async function truncate(path: PathLike, length = 0) {
  const handle = await open(path, "r+");
  try { await handle.truncate(length); } finally { await handle.close(); }
}

export { constants };
export default { open, readFile, writeFile, appendFile, mkdir, readdir, stat, lstat, statfs, access, rename, unlink, rmdir, rm, realpath, mkdtemp, copyFile, chmod, truncate, constants, FileHandle };
