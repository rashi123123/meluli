import { he } from "./locale";
import type { TranscriptRecord } from "./types";

/** A name for lists, headings and exported files. A recording has none, so its opening words stand in. */
export function getTranscriptTitle(transcript: Pick<TranscriptRecord, "sourceTitle" | "importedFileName" | "sourceType" | "text">): string {
  if (transcript.sourceTitle) return transcript.sourceTitle;
  if (transcript.importedFileName) return transcript.importedFileName;
  if (transcript.sourceType === "youtube") return he.youtubeFallbackTitle;
  const opening = transcript.text.trim().split(/\s+/).slice(0, 8).join(" ");
  return opening || he.microphoneLabel;
}
