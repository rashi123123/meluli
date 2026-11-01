import { lstat } from "node:fs/promises";
import { modelFilePath, verifyModelFile, type VerifiedModelManifest } from "./verified-download";

/** Hash once per process/file version; cheap metadata checks detect later replacement. */
export class ModelIntegrity {
  private verified = new Map<string, string>();
  private pending = new Map<string, Promise<boolean>>();

  constructor(private readonly manifest: VerifiedModelManifest) {}

  invalidate(directory: string): void { this.verified.delete(directory); }

  async verify(directory: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const running = this.pending.get(directory);
    if (running) return running;
    const task = this.verifyInternal(directory, signal);
    this.pending.set(directory, task);
    try { return await task; }
    finally { if (this.pending.get(directory) === task) this.pending.delete(directory); }
  }

  private async fingerprint(directory: string): Promise<string | null> {
    try {
      if (!(await lstat(directory)).isDirectory()) return null;
      const entries = await Promise.all(this.manifest.files.map(async file => {
        const info = await lstat(modelFilePath(directory, file.path), { bigint: true });
        if (!info.isFile() || info.size !== BigInt(file.bytes)) return null;
        return [file.path, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
      }));
      return entries.some(entry => entry === null) ? null : entries.join("|");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return null;
      throw error;
    }
  }

  private async verifyInternal(directory: string, signal?: AbortSignal): Promise<boolean> {
    const before = await this.fingerprint(directory);
    if (before && this.verified.get(directory) === before) return true;
    this.verified.delete(directory);
    if (!before) return false;
    for (const file of this.manifest.files) {
      if (!(await verifyModelFile(modelFilePath(directory, file.path), file, signal))) return false;
    }
    // Never bless a model that changed while its bytes were being verified.
    if (await this.fingerprint(directory) !== before) return false;
    this.verified.set(directory, before);
    return true;
  }
}
