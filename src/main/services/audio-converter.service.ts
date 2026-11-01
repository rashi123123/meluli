import { spawn, type ChildProcess } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { he } from "@shared/locale";

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
    if (process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1") {
      await writeFile(outputPath, "mock wav", "utf8");
      return outputPath;
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/afconvert", buildAfconvertArgs(inputPath, outputPath));

      this.processes.add(child);
      const abort = () => {
        child.kill("SIGTERM");
        const timeout = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
        timeout.unref();
        child.once("close", () => clearTimeout(timeout));
      };
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
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(he.audioConversionFailed));
      });
    });

    await normalizeExtensiblePcmWav(outputPath);
    return outputPath;
  }
}
