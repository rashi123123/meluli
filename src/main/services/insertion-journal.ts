import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface InsertionRecovery {
  transcriptText: string;
  audioPath: string | null;
  evidencePath: string;
  target: Record<string, unknown> | null;
}
type Outcome = "confirmed" | "not_dispatched" | "unresolved" | "command_completed_unverified" | "dispatched_unverified" | "outcome_uncertain";

/** Durable at-most-once dispatch guard. Uncertain outcomes require human inspection. */
export class InsertionJournal {
  private owners = new Map<string, string>();
  private updating = new Set<string>();
  constructor(private readonly root: string) {}
  /** Forget only in-memory authority; the durable no-retry claim remains. */
  releaseOwnership(sessionId: string): void { this.owners.delete(sessionId); }
  private async update<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    if (this.updating.has(sessionId)) throw new Error("Concurrent insertion receipt update blocked.");
    this.updating.add(sessionId);
    try { return await action(); } finally { this.updating.delete(sessionId); }
  }
  private path(sessionId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error("Invalid insertion session.");
    return join(this.root, sessionId + ".json");
  }
  private async syncDirectory(): Promise<void> {
    const directory = await open(this.root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async replace(sessionId: string, value: Record<string, unknown>): Promise<void> {
    const destination = this.path(sessionId), pending = destination + "." + randomUUID() + ".pending";
    const file = await open(pending, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    try { await rename(pending, destination); await this.syncDirectory(); }
    finally { await rm(pending, { force: true }); }
  }
  private async reserved(sessionId: string): Promise<Record<string, unknown>> {
    const value = JSON.parse(await readFile(this.path(sessionId), "utf8")) as Record<string, unknown>;
    if (!this.owners.has(sessionId) || value.owner !== this.owners.get(sessionId) || value.sessionId !== sessionId || value.state !== "dispatch_reserved" || value.automaticRetryAllowed !== false)
      throw new Error("Insertion claim is absent or already settled.");
    return value;
  }
  async claim(sessionId: string, transcriptId: string): Promise<boolean> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.path(sessionId), "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try {
      const owner = randomUUID();
      await file.writeFile(JSON.stringify({ sessionId, transcriptId, owner, state: "dispatch_reserved", automaticRetryAllowed: false }));
      await file.sync();
      this.owners.set(sessionId, owner);
    } finally { await file.close(); }
    try { await this.syncDirectory(); }
    catch (error) { this.releaseOwnership(sessionId); throw error; }
    return true;
  }
  async attachRecovery(sessionId: string, transcriptId: string, recovery: InsertionRecovery): Promise<void> {
    return this.update(sessionId, async () => {
      const value = await this.reserved(sessionId);
      if (value.transcriptId !== "pending-transcript" && value.transcriptId !== transcriptId) throw new Error("Insertion transcript does not own this claim.");
      await this.replace(sessionId, { ...value, transcriptId, recovery, updatedAt: Date.now() });
    });
  }
  async settle(sessionId: string, transcriptId: string, state: Outcome): Promise<void> {
    return this.update(sessionId, async () => {
      const value = await this.reserved(sessionId);
      if (value.transcriptId !== "pending-transcript" && value.transcriptId !== transcriptId) throw new Error("Insertion transcript does not own this claim.");
      await this.replace(sessionId, { ...value, transcriptId, state, automaticRetryAllowed: false, updatedAt: Date.now() });
      this.owners.delete(sessionId);
    });
  }
}
