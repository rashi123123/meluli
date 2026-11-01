import { getTranscriptCues } from "@shared/transcript-cues";
import type { TranscriptEdit, TranscriptRecord } from "@shared/types";
import { formatCallText } from "./calls/call-transcript";
import { enhanceTranscript, type EnhanceTranscriptOptions } from "./transcript-enhancer.service";

export type TranscriptContent = Pick<TranscriptRecord, "text" | "paragraphs" | "segments">;

/**
 * Cue edits keep their timings and go back through the enhancer, so the reading
 * text stays as clean as a new transcript. Free text is what the person typed.
 */
export function applyTranscriptEdit(
  transcript: TranscriptRecord,
  edit: TranscriptEdit,
  options: EnhanceTranscriptOptions
): TranscriptContent {
  const cues = getTranscriptCues(transcript);
  if ("text" in edit) {
    if (cues.length > 0) throw new Error("Timed transcripts are edited cue by cue");
    return { text: edit.text, paragraphs: null, segments: transcript.segments ?? null };
  }

  if (edit.cueTexts.length !== cues.length) throw new Error("Transcript cues changed while editing");
  const segments = cues
    .map((cue, index) => ({ ...cue, text: edit.cueTexts[index]!.trim() }))
    .filter((cue) => cue.text);
  if (segments.length === 0) throw new Error("A transcript needs at least one cue");

  if (transcript.sourceType === "call") {
    return { ...formatCallText(segments, (text) => enhanceTranscript(text, options).text || text), segments };
  }

  const joined = segments.map((cue) => cue.text).join(" ");
  const enhanced = enhanceTranscript(joined, options);
  return { text: enhanced.text || joined, paragraphs: enhanced.paragraphs, segments };
}
