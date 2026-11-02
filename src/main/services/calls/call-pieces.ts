export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 30;
export const WAV_HEADER_BYTES = 44;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const MIN_THRESHOLD = 0.006;
/** Anything this loud is kept, so a speaker who barely pauses does not become the noise floor. */
const MAX_THRESHOLD = 0.04;
const HANG_MS = 500;
const PAD_MS = 200;
const MIN_REGION_MS = 240;
const GAP_MS = 300;
export const MAX_PIECE_MS = 240_000;
const SPLIT_SEARCH_MS = 30_000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface PieceSpan extends TimeRange {
  /** Where this span starts inside the piece. */
  pieceMs: number;
}

export interface CallPiece {
  spans: PieceSpan[];
  durationMs: number;
}

/** Root mean square of one frame of 16-bit audio, from 0 to 1. */
export function frameLevel(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / samples.length);
}

export function frameBytes(): number {
  return FRAME_SAMPLES * 2;
}

function noiseFloor(levels: Float32Array): number {
  const audible = Array.from(levels).filter((level) => level > 0).sort((a, b) => a - b);
  return audible[Math.floor(audible.length * 0.1)] ?? 0;
}

/**
 * The model invents text on silence and on steady noise, so it only sees speech. The threshold
 * follows the room, because a laptop in a quiet office and a call on a street share no fixed level.
 */
export function findSpeech(levels: Float32Array): TimeRange[] {
  const threshold = Math.min(Math.max(noiseFloor(levels) * 3, MIN_THRESHOLD), MAX_THRESHOLD);
  const raw: TimeRange[] = [];
  for (let index = 0; index < levels.length; index += 1) {
    if (levels[index]! < threshold) continue;
    const startMs = index * FRAME_MS;
    const previous = raw.at(-1);
    if (previous && startMs - previous.endMs <= HANG_MS) previous.endMs = startMs + FRAME_MS;
    else raw.push({ startMs, endMs: startMs + FRAME_MS });
  }
  const totalMs = levels.length * FRAME_MS;
  const regions: TimeRange[] = [];
  for (const region of raw) {
    if (region.endMs - region.startMs < MIN_REGION_MS) continue;
    const startMs = Math.max(0, region.startMs - PAD_MS);
    const endMs = Math.min(totalMs, region.endMs + PAD_MS);
    const previous = regions.at(-1);
    if (previous && startMs <= previous.endMs) previous.endMs = endMs;
    else regions.push({ startMs, endMs });
  }
  return regions;
}

/** Cuts at the quietest moment before the limit, so no word is split if it can be helped. */
function splitLong(region: TimeRange, levels: Float32Array): TimeRange[] {
  const parts: TimeRange[] = [];
  let startMs = region.startMs;
  while (region.endMs - startMs > MAX_PIECE_MS) {
    const limit = startMs + MAX_PIECE_MS;
    let cutFrame = Math.floor(limit / FRAME_MS);
    for (let frame = cutFrame; frame >= Math.floor((limit - SPLIT_SEARCH_MS) / FRAME_MS); frame -= 1) {
      if (levels[frame]! < levels[cutFrame]!) cutFrame = frame;
    }
    const cutMs = cutFrame * FRAME_MS;
    parts.push({ startMs, endMs: cutMs });
    startMs = cutMs;
  }
  parts.push({ startMs, endMs: region.endMs });
  return parts;
}

/** Short pieces let dictation take the model back quickly, between one piece and the next. */
export function planPieces(levels: Float32Array): CallPiece[] {
  const pieces: CallPiece[] = [];
  let current: CallPiece = { spans: [], durationMs: 0 };
  for (const part of findSpeech(levels).flatMap((region) => splitLong(region, levels))) {
    const length = part.endMs - part.startMs;
    const gap = current.spans.length > 0 ? GAP_MS : 0;
    if (current.durationMs + gap + length > MAX_PIECE_MS) {
      pieces.push(current);
      current = { spans: [], durationMs: 0 };
    }
    const pieceMs = current.durationMs + (current.spans.length > 0 ? GAP_MS : 0);
    current.spans.push({ ...part, pieceMs });
    current.durationMs = pieceMs + length;
  }
  if (current.spans.length > 0) pieces.push(current);
  return pieces;
}

/** Gives the place in the call for a time inside a piece. Silence between spans belongs to the span before it. */
export function pieceToCallMs(piece: CallPiece, pieceMs: number): number {
  const spans = piece.spans;
  let span = spans[0]!;
  for (const candidate of spans) {
    if (candidate.pieceMs > pieceMs) break;
    span = candidate;
  }
  const length = span.endMs - span.startMs;
  const inside = pieceMs - span.pieceMs;
  return span.startMs + Math.min(inside, length);
}
