import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { DictationPreview } from "@shared/experimental-dictation";
import type { TranscriptionStartInput, TranscriptSegment } from "@shared/types";
import type { NormalizedTranscriptionResult } from "./transcription.service";
import { TranscriptionCanceledError } from "./transcription.service";
import { pipelineTrace } from "../pipeline-trace";

const RATE = 16_000;
const MAX_SAMPLES = RATE * 20 * 60;

export function experimentalDictationRoot(isPackaged: boolean, userDataPath: string, env = process.env): string | null {
  if (isPackaged || env.MELULI_EXPERIMENTAL_DICTATION !== "1") return null;
  const profile = env.MELULI_USER_DATA;
  const assets = env.MELULI_EXPERIMENT_ASSETS;
  if (!profile || !assets || !isAbsolute(profile) || !isAbsolute(assets) || resolve(profile) !== resolve(userDataPath)) {
    throw new Error("Experimental dictation requires explicit isolated profile and asset paths.");
  }
  const actual = realpathSync(userDataPath);
  const personal = join(process.env.HOME ?? "", "Library/Application Support/IvritMenuBar");
  let canonicalPersonal = resolve(personal);
  try { canonicalPersonal = realpathSync(personal); } catch { /* Fresh installations may not have a profile. */ }
  if (actual === canonicalPersonal || actual.startsWith(canonicalPersonal + "/")) {
    throw new Error("Experimental dictation cannot use the ordinary application profile.");
  }
  return join(assets, "sessions");
}

export function pcmWav(pcm: Float32Array): Buffer {
  const wav = Buffer.alloc(44 + pcm.length * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  return wav;
}

interface Session {
  id: string; directory: string; file: FileHandle; sequence: number; samples: number;
  committedSamples: number; stableText: string; stableSegments: TranscriptSegment[];
  previousWords: string[]; last: NormalizedTranscriptionResult | null; decodedSamples: number;
  work: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null;
  ended: boolean; canceled: boolean; finishing: boolean; decodeError: string | null; startedAt: number;
  lastDecodeStartedAt: number;
}

/** Research-only live coordinator. Durable source audio is independent of decode scheduling. */
export class ExperimentalDictationService {
  private session: Session | null = null;
  private writes: Promise<void> = Promise.resolve();
  private pendingRecovery: { directory: string; pcm: Float32Array } | null = null;
  get active(): boolean { return this.session !== null; }
  get pendingRecoverySamples(): number { return this.pendingRecovery?.pcm.length ?? 0; }
  constructor(
    private readonly root: string,
    private readonly decode: (input: TranscriptionStartInput) => Promise<NormalizedTranscriptionResult>,
    private readonly publish: (preview: DictationPreview) => void,
    private readonly intervalMs = 1000,
    private readonly liveDecode = true,
    private readonly overlapFinalization = false
  ) {}

  async begin(): Promise<string> {
    if (this.session) throw new Error("A dictation session is already active.");
    // If storage failed, retain one bounded full capture in main-process memory.
    // Do not begin another capture until that source has been persisted. This
    // retries source storage only, never transcription or an uncertain paste.
    if (this.pendingRecovery) {
      await this.persistRecovery(this.pendingRecovery.directory, this.pendingRecovery.pcm);
      this.pendingRecovery = null;
    }
    const id = randomUUID(), directory = join(this.root, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(join(directory, "original.f32le"), "wx+", 0o600);
    this.writes = Promise.resolve();
    this.session = { id, directory, file, sequence: 0, samples: 0, committedSamples: 0,
      stableText: "", stableSegments: [], previousWords: [], last: null, decodedSamples: 0,
      work: null, timer: null, ended: false, canceled: false, finishing: false, decodeError: null, startedAt: performance.now(),
      lastDecodeStartedAt: Number.NEGATIVE_INFINITY };
    try { await this.journal(this.session, "recording"); }
    catch (error) { this.session = null; await file.close(); throw error; }
    return id;
  }

  append(id: string, sequence: number, pcm: Float32Array): Promise<void> {
    const s = this.require(id);
    // Serialize disk writes, including after a failed append. Never drop a frame
    // because a newer decode request has arrived.
    const task = this.writes.then(async () => {
      if (s.ended || sequence !== s.sequence || s.samples + pcm.length > MAX_SAMPLES) {
        throw new Error("Audio sequence gap, duplicate, closed session or length limit.");
      }
      const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await s.file.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error("Audio archive write made no progress.");
        offset += bytesWritten;
      }
      s.sequence++; s.samples += pcm.length;
      this.schedule(s);
    });
    this.writes = task;
    return task;
  }

  private require(id: string): Session {
    if (!this.session || this.session.id !== id || this.session.canceled) throw new Error("Stale dictation session.");
    return this.session;
  }

  private schedule(s: Session): void {
    if (!this.liveDecode) return;
    if (s.ended || s.canceled || s.finishing || s.timer || s.work || s.samples < RATE * 1.5 || s.decodeError) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      if (s.ended || s.canceled) return;
      s.lastDecodeStartedAt = performance.now();
      s.work = this.process(s, false).catch(async () => {
        s.decodeError = "Live decoding failed; original audio retained for final fallback.";
        if (!s.canceled) this.preview(s, s.last?.text ?? "");
        // A full/unavailable archive volume can also prevent the status journal.
        // Keep the original handle and surface the final recovery failure, rather
        // than leaving a rejected background promise or closing accepted writes.
        await this.journal(s, "live_decode_failed").catch(() => undefined);
      }).finally(() => { s.work = null; if (s.samples > s.decodedSamples) this.schedule(s); });
    }, Math.max(0, this.intervalMs - (performance.now() - s.lastDecodeStartedAt)));
  }

  private async process(s: Session, final: boolean): Promise<void> {
    const end = s.samples, start = s.committedSamples;
    if (end === s.decodedSamples && s.last) return;
    // Positional read permits append-only capture to continue without touching
    // the source file offset. Only this uncommitted suffix is re-decoded.
    const bytes = Buffer.alloc((end - start) * 4);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await s.file.read(bytes, offset, bytes.length - offset, start * 4 + offset);
      if (!bytesRead) throw new Error("Incomplete audio archive.");
      offset += bytesRead;
    }
    const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    const wavPath = join(s.directory, `decode-${start}-${end}.wav`);
    pipelineTrace("experimental_wav_preprocessing", "start");
    await writeFile(wavPath, pcmWav(pcm), { mode: 0o600 });
    pipelineTrace("experimental_wav_preprocessing", "end");
    pipelineTrace("asr", "start", { final, liveDecode: this.liveDecode });
    let result: NormalizedTranscriptionResult;
    try { result = await this.decode({ wavPath, sourceType: "microphone", durationMs: pcm.length / RATE * 1000 }); }
    finally { pipelineTrace("asr", "end"); }
    if (s.canceled || this.session !== s) return;
    const shifted = (result.segments ?? []).map(segment => ({ ...segment, start: segment.start + start / RATE, end: segment.end + start / RATE }));
    const text = [s.stableText, result.text.trim()].filter(Boolean).join(" ");
    s.last = { ...result, text, segments: [...s.stableSegments, ...shifted] };
    s.decodedSamples = end;
    if (!final) {
      const words = result.text.trim().split(/\s+/u).filter(Boolean);
      let common = 0;
      while (common < Math.min(words.length, s.previousWords.length) && words[common] === s.previousWords[common]) common++;
      let committedWords = 0, newEnd = start;
      const segments: TranscriptSegment[] = [];
      for (const segment of shifted) {
        const count = segment.text.trim().split(/\s+/u).filter(Boolean).length;
        if (!count || committedWords + count > common || segment.end > end / RATE - 0.8 || segment.end <= newEnd / RATE) break;
        committedWords += count; newEnd = Math.floor(segment.end * RATE); segments.push(segment);
      }
      if (newEnd > start) {
        s.stableText = [s.stableText, words.slice(0, committedWords).join(" ")].filter(Boolean).join(" ");
        s.stableSegments.push(...segments); s.committedSamples = newEnd; s.previousWords = [];
      } else s.previousWords = words;
    }
    if (!final) this.preview(s, text);
    await this.journal(s, final ? "decoded_final" : "recording");
  }

  private preview(s: Session, text: string): void {
    this.publish({ sessionId: s.id, text, stableText: s.stableText,
      audioSamples: s.samples, decodedSamples: s.decodedSamples, ...(s.decodeError ? { error: s.decodeError } : {}) });
  }

  private journal(s: Session, status: string): Promise<void> {
    return writeFile(join(s.directory, "session.json"), JSON.stringify({ id: s.id, status,
      sampleRate: RATE, samples: s.samples, nextSequence: s.sequence, committedSamples: s.committedSamples,
      decodedSamples: s.decodedSamples, elapsedMs: performance.now() - s.startedAt,
      originalAudioRetained: true, rawResult: s.last, error: s.decodeError }, null, 2), { mode: 0o600 });
  }

  private async persistRecovery(directory: string, pcm: Float32Array): Promise<void> {
    const temporary = join(directory, "recovery-full.f32le.pending");
    await writeFile(temporary, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), { mode: 0o600 });
    const file = await open(temporary, "r");
    try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(directory, "recovery-full.f32le"));
  }

  private async verifyFinalArchive(s: Session, pcm: Float32Array, sampleRate: number): Promise<void> {
    pipelineTrace("archive_final_flush_verify", "start");
    try {
      try { await this.persistRecovery(s.directory, pcm); }
      catch (error) { this.pendingRecovery = { directory: s.directory, pcm: pcm.slice() }; throw error; }
      await this.writes;
      await s.file.sync();
      if (sampleRate !== RATE || s.samples !== pcm.length) throw new Error("Audio coverage mismatch; complete source retained.");
      const archived = await readFile(join(s.directory, "original.f32le"));
      if (!archived.equals(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))) throw new Error("Audio integrity mismatch; both originals retained.");
    } finally { pipelineTrace("archive_final_flush_verify", "end"); }
  }

  async finish(pcm: Float32Array, sampleRate: number): Promise<NormalizedTranscriptionResult> {
    const s = this.session;
    if (!s || s.ended || s.finishing) throw new Error("No open experimental session.");
    s.finishing = true;
    // Preserve renderer's complete source first, even when a chunk failed IPC.
    if (s.timer) clearTimeout(s.timer);
    try {
      const decodeFinal = async () => {
        await this.writes;
        s.ended = true;
        await s.work;
        if (s.canceled) throw new TranscriptionCanceledError();
        if (s.decodeError) {
          s.committedSamples = 0; s.stableText = ""; s.stableSegments = []; s.decodedSamples = 0; s.last = null;
        }
        await this.process(s, true);
      };
      if (this.overlapFinalization) {
        // Positional decoder reads and fsync can overlap after accepted writes.
        // Join BOTH tasks before exposing a final preview/result to the workflow;
        // on either failure, drain the other before closing the original handle.
        const outcomes = await Promise.allSettled([this.verifyFinalArchive(s, pcm, sampleRate), decodeFinal()]);
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
      } else {
        await this.verifyFinalArchive(s, pcm, sampleRate);
        await decodeFinal();
      }
      if (s.canceled) throw new TranscriptionCanceledError();
      if (!s.last) throw new Error("Missing final dictation result.");
      this.preview(s, s.last.text);
      await this.journal(s, "awaiting_store_and_paste");
      return s.last;
    } catch (error) {
      await this.journal(s, s.canceled ? "canceled_audio_retained" : "failed_audio_retained");
      throw error;
    } finally {
      if (s.timer) clearTimeout(s.timer);
      await this.writes.catch(() => undefined);
      s.ended = true;
      await s.work;
      await s.file.close();
      // Keep the session journal and all originals, including on failure.
      this.session = null;
    }
  }

  async cancel(): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.canceled = true;
    if (s.timer) clearTimeout(s.timer);
    await this.writes.catch(() => undefined);
    await s.work;
    if (s.finishing) return; // finish owns the descriptor and terminal cleanup.
    s.ended = true;
    try { await s.file.sync(); await this.journal(s, "canceled_audio_retained"); }
    finally { await s.file.close(); if (this.session === s) this.session = null; }
  }

  async recordWorkflowOutcome(sessionId: string, status: string, transcriptId?: string): Promise<void> {
    // This is a workflow receipt, not proof that an arbitrary external editor
    // consumed Paste. Only the dedicated acceptance editor can establish that.
    await writeFile(join(this.root, sessionId, "workflow.json"), JSON.stringify({
      status, transcriptId, atMainMonotonicNs: process.hrtime.bigint().toString(),
      nativePasteConsumptionVerified: false, originalAudioRetained: true
    }, null, 2), { mode: 0o600 });
  }
}
