import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { MAX_RECORDING_DURATION_MS, MAX_RECORDING_SAMPLE_RATE, MIN_DICTATION_MS, RECORDING_AUDIO_RETENTION_MS } from "@shared/constants";
import type { StoredRecording } from "@shared/types";
import { pcm16 as int16, WAV_HEADER_BYTES, wavHeader } from "./pcm-wav";
import { processIsAlive, writeJsonAtomic } from "./system-probes";

/** A little room past the recording limit for the last buffer the microphone hands over. */
const MAX_SPOOL_MS = MAX_RECORDING_DURATION_MS + 60_000;
/** 32-bit samples at the highest rate the store accepts, for the longest spool. */
const MAX_AUDIO_BYTES = WAV_HEADER_BYTES + Math.ceil(MAX_SPOOL_MS / 1000) * MAX_RECORDING_SAMPLE_RATE * 4;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRY = /^([0-9a-f-]{36})\.(json|wav|partial\.wav)$/;
/** A file without its record is left for this long, in case another write is about to add it. */
const STRAY_MIN_AGE_MS = 60 * 60_000;

const recordSchema = z.object({
  id: z.string().regex(ID),
  createdAt: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  sampleRate: z.number().int().positive().max(MAX_RECORDING_SAMPLE_RATE),
  status: z.enum(["recording", "kept", "failed"]),
  transcriptId: z.string().min(1).nullable(),
  ownerPid: z.number().int().positive().nullable()
});
type RecordingRecord = z.infer<typeof recordSchema>;

interface Spool {
  /** Null until the first link of `writes` opens the partial file. */
  file: FileHandle | null;
  sequence: number;
  samples: number;
  sampleRate: number;
  createdAt: number;
  writes: Promise<void>;
  broken: boolean;
}

export interface RecordingAudioStoreOptions {
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  retentionMs?: number;
  onChange?: () => void;
}

/**
 * Microphone audio on disk, one recording per id under `root`:
 * - `<id>.partial.wav` is written while the person speaks, so a crash or a lost window
 *   leaves the speech behind instead of nothing. Its header is filled in when it closes.
 * - `<id>.wav` with `<id>.json` is a finished recording: `kept` beside its transcript for
 *   the retention period, or `failed` until it is transcribed or discarded.
 */
export class RecordingAudioStore {
  private readonly spools = new Map<string, Spool>();
  /** Chunks can arrive after main already has the whole recording; they must not reopen it. */
  private readonly closed = new Set<string>();
  private readonly now: () => number;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly retentionMs: number;

  constructor(private readonly root: string, private readonly options: RecordingAudioStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? processIsAlive;
    this.retentionMs = options.retentionMs ?? RECORDING_AUDIO_RETENTION_MS;
  }

  audioPath(id: string): string { return join(this.root, `${this.checkId(id)}.wav`); }
  private partialPath(id: string): string { return join(this.root, `${this.checkId(id)}.partial.wav`); }
  private recordPath(id: string): string { return join(this.root, `${this.checkId(id)}.json`); }

  private checkId(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid recording id.");
    return id;
  }

  private changed(): void { this.options.onChange?.(); }

  private async writeRecord(record: RecordingRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.recordPath(record.id), record);
  }

  private async readRecord(id: string): Promise<RecordingRecord | null> {
    const raw = await readFile(this.recordPath(id), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const record = recordSchema.parse(JSON.parse(raw));
      return record.id === id ? record : null;
    } catch { return null; }
  }

  private markClosed(id: string): void {
    this.closed.add(id);
    if (this.closed.size > 64) this.closed.delete(this.closed.values().next().value!);
  }

  /** Appends one chunk of the recording that is still going on. Chunks must arrive in order. */
  append(id: string, sequence: number, sampleRate: number, pcm: Float32Array): Promise<void> {
    if (!ID.test(id)) return Promise.reject(new Error("Invalid recording id."));
    if (this.closed.has(id)) return Promise.resolve();
    let spool = this.spools.get(id);
    if (!spool) {
      if (sequence !== 0) return Promise.reject(new Error("A recording's audio must start at its first chunk."));
      const opening: Spool = { file: null, sequence: 0, samples: 0, sampleRate, createdAt: this.now(), writes: Promise.resolve(), broken: false };
      opening.writes = (async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const file = opening.file = await open(this.partialPath(id), "wx", 0o600);
        await file.write(wavHeader(0, sampleRate), 0, WAV_HEADER_BYTES, 0);
        await this.writeRecord({ id, createdAt: opening.createdAt, durationMs: 0, sampleRate, status: "recording", transcriptId: null, ownerPid: this.pid });
      })();
      this.spools.set(id, opening);
      spool = opening;
    }
    const target = spool;
    const task = target.writes.then(async () => {
      if (target.broken || sequence !== target.sequence || sampleRate !== target.sampleRate) {
        throw new Error("Recording audio arrived out of order.");
      }
      if (target.samples + pcm.length > Math.ceil(sampleRate * MAX_SPOOL_MS / 1000)) throw new Error("Recording audio is longer than allowed.");
      const file = target.file;
      if (!file) throw new Error("Recording audio arrived out of order.");
      const bytes = int16(pcm);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, WAV_HEADER_BYTES + target.samples * 2 + offset);
        if (!bytesWritten) throw new Error("Recording audio write made no progress.");
        offset += bytesWritten;
      }
      target.sequence += 1;
      target.samples += pcm.length;
    });
    // One lost chunk would shift everything after it, so the rest of this recording is refused.
    target.writes = task.catch(() => { target.broken = true; });
    return task;
  }

  /** Closes the recording that is being written, without keeping it. */
  async discardSpool(id: string): Promise<void> {
    this.markClosed(this.checkId(id));
    const spool = this.spools.get(id);
    this.spools.delete(id);
    if (spool) {
      await spool.writes;
      await spool.file?.close().catch(() => undefined);
    }
    const record = await this.readRecord(id);
    if (record && record.status !== "recording") return;
    await rm(this.partialPath(id), { force: true });
    await rm(this.recordPath(id), { force: true });
  }

  /** Turns the recording that is being written into a failed one that waits for the person. */
  async keepSpool(id: string): Promise<boolean> {
    this.markClosed(this.checkId(id));
    const spool = this.spools.get(id);
    this.spools.delete(id);
    if (!spool) return false;
    await spool.writes;
    const record = { id, createdAt: spool.createdAt, sampleRate: spool.sampleRate, ownerPid: null, transcriptId: null };
    try {
      return await this.finishPartial(spool.file, spool.samples * 2, record);
    } finally { await spool.file?.close().catch(() => undefined); }
  }

  /** Keeps every recording still being written, as after a crash. */
  async keepOpenSpools(): Promise<void> {
    for (const id of [...this.spools.keys()]) await this.keepSpool(id).catch(() => undefined);
  }

  private async finishPartial(file: FileHandle | null, dataBytes: number, record: Omit<RecordingRecord, "status" | "durationMs">): Promise<boolean> {
    const durationMs = dataBytes / 2 / record.sampleRate * 1000;
    if (!file || durationMs < MIN_DICTATION_MS) {
      await rm(this.partialPath(record.id), { force: true });
      await rm(this.recordPath(record.id), { force: true });
      return false;
    }
    await file.write(wavHeader(dataBytes, record.sampleRate), 0, WAV_HEADER_BYTES, 0);
    await file.sync().catch(() => undefined);
    await rename(this.partialPath(record.id), this.audioPath(record.id));
    await this.writeRecord({ ...record, status: "failed", durationMs: Math.round(durationMs) });
    this.changed();
    return true;
  }

  /**
   * Stores a finished recording's WAV under `id`, moving it from `wavPath`. Main already
   * holds the whole recording, so whatever was written while it lasted is no longer needed.
   */
  async keep(id: string, wavPath: string, input: { status: "kept" | "failed"; transcriptId: string | null; durationMs: number; sampleRate: number }): Promise<void> {
    await this.discardSpool(id);
    const previous = await this.readRecord(id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await rename(wavPath, this.audioPath(id));
    await this.writeRecord({
      id,
      createdAt: previous?.createdAt ?? Math.max(0, Math.round(this.now() - input.durationMs)),
      durationMs: Math.round(input.durationMs),
      sampleRate: input.sampleRate,
      status: input.status,
      transcriptId: input.transcriptId,
      ownerPid: null
    });
    this.changed();
  }

  /** A failed recording now has its transcript, so it ages out like any other. */
  async attachTranscript(id: string, transcriptId: string, keep: boolean): Promise<void> {
    const record = await this.readRecord(this.checkId(id));
    if (!record || record.status === "recording") return;
    if (!keep) { await this.remove(id); return; }
    await this.writeRecord({ ...record, status: "kept", transcriptId });
    this.changed();
  }

  async get(id: string): Promise<StoredRecording | null> {
    if (!ID.test(id)) return null;
    const record = await this.readRecord(id);
    if (!record || record.status === "recording") return null;
    const audio = await stat(this.audioPath(id)).catch(() => null);
    if (!audio?.isFile()) return null;
    return { id: record.id, createdAt: record.createdAt, durationMs: record.durationMs, status: record.status, transcriptId: record.transcriptId };
  }

  /** The WAV of a finished recording, for playback. Null once it is gone or larger than any recording can be. */
  async readAudio(id: string): Promise<Uint8Array | null> {
    if (!(await this.get(id))) return null;
    const file = await open(this.audioPath(id), "r").catch(() => null);
    if (!file) return null;
    try {
      const { size } = await file.stat();
      if (size <= WAV_HEADER_BYTES || size > MAX_AUDIO_BYTES) return null;
      return new Uint8Array(await file.readFile());
    } finally {
      await file.close();
    }
  }

  /** Finished recordings, newest first. */
  async list(): Promise<StoredRecording[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const ids = names.map(name => /^([0-9a-f-]{36})\.json$/.exec(name)?.[1]).filter((id): id is string => Boolean(id && ID.test(id)));
    const recordings = await Promise.all(ids.map(id => this.get(id)));
    return recordings.filter((recording): recording is StoredRecording => recording !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(id: string): Promise<void> {
    this.checkId(id);
    if (this.spools.has(id)) await this.discardSpool(id);
    await rm(this.audioPath(id), { force: true });
    await rm(this.partialPath(id), { force: true });
    await rm(this.recordPath(id), { force: true });
    this.changed();
  }

  async removeForTranscript(transcriptId: string): Promise<void> {
    for (const recording of await this.list()) {
      if (recording.transcriptId === transcriptId) await this.remove(recording.id);
    }
  }

  async clear(): Promise<void> {
    for (const id of [...this.spools.keys()]) await this.discardSpool(id).catch(() => undefined);
    await rm(this.root, { recursive: true, force: true, maxRetries: 5 });
    this.changed();
  }

  /**
   * Keeps what a crashed or closed run was still writing, then removes kept recordings past
   * their time and files that lost their record. Failed recordings wait for the person.
   */
  async sweep(keepTranscribed: boolean): Promise<void> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const now = this.now();
    const ids = new Set(names.map(name => ENTRY.exec(name)?.[1]).filter((id): id is string => Boolean(id && ID.test(id))));
    let changed = false;
    for (const id of ids) {
      if (this.spools.has(id)) continue;
      const record = await this.readRecord(id);
      if (!record) {
        for (const name of [`${id}.wav`, `${id}.partial.wav`]) {
          const path = join(this.root, name), info = await stat(path).catch(() => null);
          if (info?.isFile() && now - info.mtimeMs >= STRAY_MIN_AGE_MS) { await rm(path, { force: true }); changed = true; }
        }
        continue;
      }
      if (record.status === "recording") {
        if (record.ownerPid === this.pid || (record.ownerPid !== null && this.isAlive(record.ownerPid))) continue;
        const partial = this.partialPath(id), info = await stat(partial).catch(() => null);
        const file = info?.isFile() ? await open(partial, "r+").catch(() => null) : null;
        try {
          const dataBytes = Math.max(0, Math.floor(((info?.size ?? 0) - WAV_HEADER_BYTES) / 2) * 2);
          await this.finishPartial(file, dataBytes, { id, createdAt: record.createdAt, sampleRate: record.sampleRate, ownerPid: null, transcriptId: null });
        } finally { await file?.close().catch(() => undefined); }
        changed = true;
        continue;
      }
      if (record.status === "kept" && (!keepTranscribed || now - record.createdAt >= this.retentionMs)) {
        await rm(this.audioPath(id), { force: true });
        await rm(this.recordPath(id), { force: true });
        changed = true;
      }
    }
    if (changed) this.changed();
  }
}
