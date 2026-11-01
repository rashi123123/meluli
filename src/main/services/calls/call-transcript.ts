import type { CallSpeaker, TranscriptSegment } from "@shared/types";
import { he } from "@shared/locale";

const ECHO_OVERLAP = 0.5;
const ECHO_SIMILARITY = 0.6;
const TURN_GAP_SECONDS = 8;

export interface CallTurn {
  speaker: CallSpeaker;
  start: number;
  text: string;
}

function bigrams(text: string): Map<string, number> {
  const compact = text.replace(/[^\p{L}\p{N}]/gu, "");
  const counts = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const pair = compact.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Dice similarity on letter pairs, which survives the small differences between two hearings of a sentence. */
export function textSimilarity(first: string, second: string): number {
  const a = bigrams(first);
  const b = bigrams(second);
  const size = (counts: Map<string, number>) => [...counts.values()].reduce((sum, count) => sum + count, 0);
  const total = size(a) + size(b);
  if (total === 0) return 0;
  let shared = 0;
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0);
  return (2 * shared) / total;
}

function overlapRatio(segment: TranscriptSegment, other: TranscriptSegment): number {
  const overlap = Math.min(segment.end, other.end) - Math.max(segment.start, other.start);
  const length = segment.end - segment.start;
  return length > 0 ? Math.max(0, overlap) / length : 0;
}

/** Speakers leak into the microphone, so a line the call app already gave us is not the user speaking. */
export function mergeTracks(mic: TranscriptSegment[], system: TranscriptSegment[]): TranscriptSegment[] {
  const others = system.map((segment) => ({ ...segment, speaker: "others" as const }));
  const mine = mic
    .filter((segment) => !system.some((other) =>
      overlapRatio(segment, other) >= ECHO_OVERLAP && textSimilarity(segment.text, other.text) >= ECHO_SIMILARITY))
    .map((segment) => ({ ...segment, speaker: "me" as const }));
  return [...mine, ...others].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function groupTurns(segments: TranscriptSegment[]): CallTurn[] {
  const turns: CallTurn[] = [];
  let lastEnd = 0;
  for (const segment of segments) {
    const speaker = segment.speaker ?? "others";
    const previous = turns.at(-1);
    if (previous && previous.speaker === speaker && segment.start - lastEnd <= TURN_GAP_SECONDS) {
      previous.text += ` ${segment.text.trim()}`;
    } else {
      turns.push({ speaker, start: segment.start, text: segment.text.trim() });
    }
    lastEnd = segment.end;
  }
  return turns;
}

export function formatCallTime(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = pad(Math.floor((total % 3600) / 60));
  return hours > 0 ? `${hours}:${minutes}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

export function speakerLabel(speaker: CallSpeaker): string {
  return speaker === "me" ? he.callSpeakerMe : he.callSpeakerOthers;
}

export function formatTurn(turn: CallTurn, text = turn.text): string {
  return `[${formatCallTime(turn.start)}] ${speakerLabel(turn.speaker)}: ${text}`;
}

/** Each turn is cleaned alone. A sentence split across speakers would read as one person. */
export function formatCallText(segments: TranscriptSegment[], clean: (text: string) => string): { text: string; paragraphs: string[] } {
  const paragraphs = groupTurns(segments).map((turn) => formatTurn(turn, clean(turn.text)));
  return { text: paragraphs.join("\n\n"), paragraphs };
}
