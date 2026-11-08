import { open, rm, stat, writeFile } from "node:fs/promises";
import type { TranscriptSegment } from "@shared/types";
import { frameBytes, frameLevel, pieceToCallMs, planPieces, FRAME_MS, type CallPiece } from "./call-pieces";
import { WAV_HEADER_BYTES, WORKER_SAMPLE_RATE as SAMPLE_RATE, wavHeader } from "../pcm-wav";
import type { CallRecord, CallStore, CallTrack } from "./call-store";
import { mergeTracks } from "./call-transcript";

const READ_BYTES = 1 << 20;
const TRACKS: CallTrack[] = ["system", "mic"];

export interface PieceTranscriber {
  /** Waits until the model is free and rejects with `canceled` when dictation takes it back. */
  transcribePiece(wavPath: string, durationMs: number): Promise<TranscriptSegment[]>;
  waitForTurn(): Promise<void>;
  /** Spaces out retries, so a model that stays busy cannot spin this loop. */
  pauseAfterCancel(): Promise<void>;
  isCanceled(error: unknown): boolean;
}

/** How long the longest track runs. A crash leaves no end time, but the audio is still on disk. */
export async function recordedLengthMs(store: CallStore, id: string): Promise<number> {
  const sizes = await Promise.all(TRACKS.map(async (track) => (await stat(store.trackPath(id, track)).catch(() => null))?.size ?? 0));
  const bytes = Math.max(...sizes) - WAV_HEADER_BYTES;
  return bytes > 0 ? Math.round((bytes / (2 * SAMPLE_RATE)) * 1000) : 0;
}

async function readLevels(path: string): Promise<Float32Array> {
  const info = await stat(path).catch(() => null);
  if (!info || info.size <= WAV_HEADER_BYTES) return new Float32Array(0);
  const size = frameBytes();
  const levels = new Float32Array(Math.floor((info.size - WAV_HEADER_BYTES) / size));
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size * Math.floor(READ_BYTES / size));
    let frame = 0;
    let position = WAV_HEADER_BYTES;
    while (frame < levels.length) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead < size) break;
      for (let offset = 0; offset + size <= bytesRead && frame < levels.length; offset += size, frame += 1) {
        levels[frame] = frameLevel(new Int16Array(buffer.buffer, buffer.byteOffset + offset, size / 2));
      }
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  return levels;
}

function msToByte(ms: number): number {
  return Math.round((ms * SAMPLE_RATE) / 1000) * 2;
}

/** Writes the speech of one piece with its silences shortened to the gap between spans. */
async function writePiece(trackPath: string, piece: CallPiece, outputPath: string): Promise<void> {
  const audio = Buffer.alloc(msToByte(piece.durationMs));
  const file = await open(trackPath, "r");
  try {
    for (const span of piece.spans) {
      const length = msToByte(span.endMs - span.startMs);
      await file.read(audio, msToByte(span.pieceMs), Math.min(length, audio.length - msToByte(span.pieceMs)), WAV_HEADER_BYTES + msToByte(span.startMs));
    }
  } finally {
    await file.close();
  }
  await writeFile(outputPath, Buffer.concat([wavHeader(audio.length), audio]), { mode: 0o600 });
}

function toCallTime(segments: TranscriptSegment[], piece: CallPiece, offsetMs: number): TranscriptSegment[] {
  return segments.filter((segment) => segment.text.trim()).map((segment) => ({
    start: (pieceToCallMs(piece, segment.start * 1000) + offsetMs) / 1000,
    end: (pieceToCallMs(piece, segment.end * 1000) + offsetMs) / 1000,
    text: segment.text.trim()
  }));
}

/**
 * Runs one call to its merged segments. Progress is saved after each piece, so a quit, a crash or a
 * failed piece costs that piece and no more.
 */
export async function transcribeCall(
  record: CallRecord,
  store: CallStore,
  transcriber: PieceTranscriber,
  onProgress: (ratio: number) => void,
  isStopped: () => boolean
): Promise<TranscriptSegment[] | null> {
  const plans = new Map<CallTrack, CallPiece[]>();
  for (const track of TRACKS) plans.set(track, planPieces(await readLevels(store.trackPath(record.id, track))));
  const length = (pieces: CallPiece[]) => pieces.reduce((sum, piece) => sum + piece.durationMs, 0);
  const totalMs = Math.max(FRAME_MS, length(plans.get("system")!) + length(plans.get("mic")!));
  let finishedMs = 0;

  for (const track of TRACKS) {
    const pieces = plans.get(track)!;
    const progress = record[track];
    finishedMs += length(pieces.slice(0, progress.done));
    const offsetMs = track === "mic" ? record.micOffsetMs : record.systemOffsetMs;
    for (let index = progress.done; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      const path = store.piecePath(record.id);
      await writePiece(store.trackPath(record.id, track), piece, path);
      let segments: TranscriptSegment[] | null = null;
      while (!segments) {
        if (isStopped()) return null;
        await transcriber.waitForTurn();
        if (isStopped()) return null;
        onProgress(finishedMs / totalMs);
        try {
          segments = await transcriber.transcribePiece(path, piece.durationMs);
        } catch (error) {
          if (!transcriber.isCanceled(error)) throw error;
          await transcriber.pauseAfterCancel();
        }
      }
      await rm(path, { force: true });
      progress.segments.push(...toCallTime(segments, piece, offsetMs));
      progress.done = index + 1;
      await store.save(record);
      finishedMs += piece.durationMs;
      onProgress(finishedMs / totalMs);
    }
  }
  return mergeTracks(record.mic.segments, record.system.segments);
}
