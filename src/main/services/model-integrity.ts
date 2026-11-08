import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import type { VerifiedModelManifest } from "../config/model-manifest";
import { modelFilePath, verifyModelFile } from "./verified-download";
import { writeJsonAtomic } from "./system-probes";

interface VerifiedRecord { version: 1; manifest: string; directory: string; fingerprint: string }

/**
 * Hash once per file version; cheap metadata checks detect later replacement. With a record path the
 * verified fingerprint outlives the process, so a launch does not read the whole model again (834 MB
 * took 8 to 10 s from an external disk, MEASURED). The fingerprint holds each file's device, inode,
 * size and nanosecond mtime and ctime: replacing or rewriting a file changes its ctime, which no
 * ordinary process can set back, so a changed model is hashed again. The record sits in the same
 * private profile as the model, so it trusts nothing the model files do not already trust.
 */
export class ModelIntegrity {
  private verified = new Map<string, string>();
  private pending = new Map<string, Promise<boolean>>();
  private readonly manifestKey: string;
  /** invalidate() is synchronous; reads and writes of the record wait for its removal. */
  private removal: Promise<void> = Promise.resolve();

  constructor(private readonly manifest: VerifiedModelManifest, private readonly recordPath: string | null = null) {
    this.manifestKey = createHash("sha256").update(JSON.stringify([manifest.id, manifest.revision, manifest.files])).digest("hex");
  }

  invalidate(directory: string): void {
    this.verified.delete(directory);
    // The removal never rejects, and every later read or write of the record waits for it.
    void this.forgetRecord();
  }

  private forgetRecord(): Promise<void> {
    if (!this.recordPath) return this.removal;
    const path = this.recordPath;
    this.removal = this.removal.then(() => rm(path, { force: true })).catch(() => undefined);
    return this.removal;
  }

  private async readRecord(directory: string): Promise<string | null> {
    if (!this.recordPath) return null;
    await this.removal;
    try {
      const record = JSON.parse(await readFile(this.recordPath, "utf8")) as Partial<VerifiedRecord>;
      return record.version === 1 && record.manifest === this.manifestKey && record.directory === directory && typeof record.fingerprint === "string"
        ? record.fingerprint : null;
    } catch { return null; }
  }

  private async writeRecord(directory: string, fingerprint: string): Promise<void> {
    if (!this.recordPath) return;
    await this.removal;
    const record: VerifiedRecord = { version: 1, manifest: this.manifestKey, directory, fingerprint };
    // Without the record the next launch hashes again; nothing else depends on it.
    await writeJsonAtomic(this.recordPath, record).catch(() => undefined);
  }

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
    if (await this.readRecord(directory) === before) {
      this.verified.set(directory, before);
      return true;
    }
    for (const file of this.manifest.files) {
      if (!(await verifyModelFile(modelFilePath(directory, file.path), file, signal))) {
        await this.forgetRecord();
        return false;
      }
    }
    // Never bless a model that changed while its bytes were being verified.
    if (await this.fingerprint(directory) !== before) return false;
    this.verified.set(directory, before);
    await this.writeRecord(directory, before);
    return true;
  }
}
