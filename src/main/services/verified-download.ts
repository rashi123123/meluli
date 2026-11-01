import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, rename, rm, lstat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface VerifiedModelFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface VerifiedModelManifest {
  id: string;
  revision: string;
  files: readonly VerifiedModelFile[];
}

export function modelFilePath(directory: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid model file path.");
  }
  const base = resolve(directory);
  const path = resolve(base, relativePath);
  if (!path.startsWith(base + sep)) throw new Error("Model file escaped its directory.");
  return path;
}

export function isAllowedModelDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      ["huggingface.co", "hf.co"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export async function verifyModelFile(path: string, expected: VerifiedModelFile, signal?: AbortSignal): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size !== expected.bytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024, signal })) hash.update(chunk);
    return hash.digest("hex") === expected.sha256;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function fetchModelFile(url: string, offset: number, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!isAllowedModelDownloadUrl(url)) throw new Error("Untrusted model download host.");
    const response = await fetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: offset ? { Range: `bytes=${offset}-` } : {}
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Model download redirect has no destination.");
    url = new URL(location, url).href;
  }
  throw new Error("Too many model download redirects.");
}

/** Downloads into a resumable partial file, then publishes only verified bytes. */
export async function downloadVerifiedFile(
  url: string,
  path: string,
  expected: VerifiedModelFile,
  signal: AbortSignal,
  onProgress: (received: number) => void,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<void> {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new Error("Invalid model integrity manifest.");
  }
  signal.throwIfAborted();
  if (await verifyModelFile(path, expected, signal)) { onProgress(expected.bytes); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const partialPath = `${path}.partial`;
  const attempts = Math.max(1, Math.min(5, options.retries ?? 3));
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal.throwIfAborted();
    const partialInfo = await lstat(partialPath).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (partialInfo && !partialInfo.isFile()) throw new Error("Model partial file must be a regular file.");
    let offset = partialInfo?.size ?? 0;
    if (offset >= expected.bytes) {
      if (await verifyModelFile(partialPath, expected, signal)) {
        await rename(partialPath, path); onProgress(expected.bytes); return;
      }
      await rm(partialPath, { force: true }); offset = 0;
    }
    const request = new AbortController();
    const combined = AbortSignal.any([signal, request.signal]);
    let timeout: NodeJS.Timeout;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => request.abort(new Error("Model download timed out.")), options.timeoutMs ?? 60_000);
      timeout.unref();
    };
    resetTimeout();
    try {
      const response = await fetchModelFile(url, offset, combined);
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel();
        throw new Error(`Model download returned HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error("Model download returned an empty body.");
      if (response.status === 200) offset = 0; // Server ignored Range; replace, never append.
      if (response.status === 206) {
        const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) !== offset || Number(range[3]) !== expected.bytes) {
          await response.body.cancel(); throw new Error("Invalid model download byte range.");
        }
      }
      const file = await open(partialPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (offset ? constants.O_APPEND : constants.O_TRUNC), 0o600);
      let received = offset;
      try {
        onProgress(received);
        for await (const chunk of response.body) {
          combined.throwIfAborted(); resetTimeout();
          received += chunk.byteLength;
          if (received > expected.bytes) throw new Error("Model download exceeds expected size.");
          // writeFile handles short writes; only one chunk is retained at a time.
          await file.writeFile(chunk);
          onProgress(received);
        }
        await file.sync();
      } finally { await file.close(); }
      clearTimeout(timeout!);
      if (!(await verifyModelFile(partialPath, expected, signal))) {
        await rm(partialPath, { force: true });
        throw new Error("Model download integrity check failed.");
      }
      await rename(partialPath, path); onProgress(expected.bytes); return;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && "code" in error && error.code === "ENOSPC") throw error;
      if (attempt === attempts - 1) throw error;
    } finally { clearTimeout(timeout!); request.abort(); }
  }
}

export async function downloadVerifiedModel(
  manifest: VerifiedModelManifest,
  directory: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(manifest.id) || !/^[a-f0-9]{40}$/.test(manifest.revision) || !manifest.files.length) {
    throw new Error("Model manifest must name a repository and immutable revision.");
  }
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  let complete = 0;
  for (const file of manifest.files) {
    const url = `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/${file.path}`;
    await downloadVerifiedFile(url, modelFilePath(directory, file.path), file, signal,
      received => onProgress(complete + received, total));
    complete += file.bytes;
  }
}
