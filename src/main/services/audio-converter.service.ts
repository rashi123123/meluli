import { spawn, type ChildProcess } from "node:child_process";
import { open, stat, statfs, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { he } from "@shared/locale";
import { isMockMode } from "../config/mock-mode";

// A forged header understates its length to afconvert and would fool any check made before
// decoding, so the limits watch what is actually written: 16 kHz mono PCM16 is 32,000 bytes a second.
// Twelve hours is three times the longest call and far past what the job timeouts let finish.
export const MAX_DECODED_SECONDS = 12 * 60 * 60;
const MAX_WAV_BYTES = MAX_DECODED_SECONDS * 32_000 + 1024 ** 2;
const MIN_FREE_BYTES = 200 * 1024 ** 2;
const CONVERSION_DEADLINE_MS = 30 * 60_000;
const WATCH_INTERVAL_MS = 200;

export interface AudioConverterOptions {
  afconvertPath?: string;
  freeBytes?: (path: string) => Promise<number>;
  maxWavBytes?: number;
  deadlineMs?: number;
  watchIntervalMs?: number;
}

async function diskFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return info.bavail * info.bsize;
}

const fileBytes = (path: string) => stat(path).then((info) => info.size, () => 0);

export function buildAfconvertArgs(inputPath: string, outputPath: string): string[] {
  return ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", inputPath, outputPath];
}

// afconvert labels PCM from mono AAC as extensible, which the worker's reader refuses.
export async function normalizeExtensiblePcmWav(path: string): Promise<void> {
  const file = await open(path, "r+");
  try {
    const header = Buffer.alloc(46);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const extensiblePcm = bytesRead === header.length
      && header.toString("latin1", 12, 16) === "fmt "
      && header.readUInt16LE(20) === 0xfffe
      && header.readUInt16LE(44) === 1;
    if (extensiblePcm) await file.write(Buffer.from([1, 0]), 0, 2, 20);
  } finally {
    await file.close();
  }
}

export class AudioConverterService {
  private readonly processes = new Set<ChildProcess>();
  private disposed = false;

  constructor(private readonly options: AudioConverterOptions = {}) {}

  private freeBytes(path: string): Promise<number> {
    return (this.options.freeBytes ?? diskFreeBytes)(path).catch(() => Number.POSITIVE_INFINITY);
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.processes) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
      timeout.unref();
      child.once("close", () => clearTimeout(timeout));
    }
  }
  async convertInputToWav(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error(he.transcriptionCanceled);
    if (isMockMode()) {
      await writeFile(outputPath, "mock wav", "utf8");
      return outputPath;
    }

    const maxWavBytes = this.options.maxWavBytes ?? MAX_WAV_BYTES;
    const folder = dirname(outputPath);
    if (await this.freeBytes(folder) < MIN_FREE_BYTES) throw new Error(he.audioFileTooLarge);
    signal?.throwIfAborted();
    if (this.disposed) throw new Error(he.transcriptionCanceled);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.afconvertPath ?? "/usr/bin/afconvert", buildAfconvertArgs(inputPath, outputPath));

      this.processes.add(child);
      const abort = () => {
        child.kill("SIGTERM");
        const timeout = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
        timeout.unref();
        child.once("close", () => clearTimeout(timeout));
      };
      let limitError: Error | null = null;
      const exceed = (message: string) => {
        if (limitError) return;
        limitError = new Error(message);
        abort();
      };
      const watch = setInterval(() => {
        void Promise.all([fileBytes(outputPath), this.freeBytes(folder)]).then(([size, free]) => {
          if (size > maxWavBytes || free < MIN_FREE_BYTES) exceed(he.audioFileTooLarge);
        });
      }, this.options.watchIntervalMs ?? WATCH_INTERVAL_MS);
      const deadline = setTimeout(() => exceed(he.audioConversionFailed), this.options.deadlineMs ?? CONVERSION_DEADLINE_MS);
      const stopWatching = () => { clearInterval(watch); clearTimeout(deadline); };
      child.once("close", stopWatching);
      child.once("error", stopWatching);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("close", () => signal?.removeEventListener("abort", abort));
      child.once("error", () => signal?.removeEventListener("abort", abort));
      if (signal?.aborted) abort();
      child.stdout.resume();
      child.stderr.resume();
      child.once("close", () => this.processes.delete(child));
      child.once("error", () => this.processes.delete(child));

      child.on("error", reject);
      child.on("close", (code) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        if (limitError) { reject(limitError); return; }
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(he.audioConversionFailed));
      });
    });

    // A fast decoder can finish between two checks.
    if (await fileBytes(outputPath) > maxWavBytes) throw new Error(he.audioFileTooLarge);
    await normalizeExtensiblePcmWav(outputPath);
    return outputPath;
  }
}
