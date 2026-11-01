import type { TranscriptRecord, TranscriptSegment } from "./types";

function clampSegment(segment: TranscriptSegment, nextSegment?: TranscriptSegment): TranscriptSegment | null {
  if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return null;
  const start = Math.max(0, segment.start);
  const rawEnd = Math.max(start, segment.end);
  const cappedEnd = nextSegment && Number.isFinite(nextSegment.start) ? Math.min(rawEnd, Math.max(start, nextSegment.start)) : rawEnd;
  const end = cappedEnd > start ? cappedEnd : start + 0.001;
  const text = segment.text.trim();

  if (!text) {
    return null;
  }

  return {
    ...(segment.speaker ? { speaker: segment.speaker } : {}),
    start,
    end,
    text
  };
}

// NeMo provides individual word timings. Keep those in history, but group them
// into readable cues for subtitles and editing. Legacy sentence cues stay intact.
function groupWords(words: TranscriptSegment[]): TranscriptSegment[] {
  const cues: TranscriptSegment[] = [];
  for (const word of words) {
    const previous = cues.at(-1);
    if (previous && word.start - previous.end <= 0.8 && word.end - previous.start <= 5
      && previous.text.length + word.text.length + 1 <= 74 && !/[.!?؟]$/.test(previous.text)) {
      previous.end = Math.max(previous.end, word.end);
      previous.text += " " + word.text;
    } else cues.push({ ...word });
  }
  return cues;
}

export function wrapCueText(text: string): string {
  const lines: string[] = [""];
  for (const word of text.split(/\s+/)) {
    const index = lines.length - 1;
    if (lines[index] && lines[index].length + word.length + 1 > 42) lines.push(word);
    else lines[index] += (lines[index] ? " " : "") + word;
  }
  return lines.join("\n");
}

/** Readable timed cues. An edited transcript already stores its final cues. */
export function getTranscriptCues(transcript: Pick<TranscriptRecord, "segments" | "backend" | "editedAt">): TranscriptSegment[] {
  const segments = transcript.segments ?? [];
  const normalized = segments
    .map((segment, index) => clampSegment(segment, segments[index + 1]))
    .filter((segment): segment is TranscriptSegment => segment !== null);
  return transcript.backend === "nemo" && !transcript.editedAt ? groupWords(normalized) : normalized;
}
