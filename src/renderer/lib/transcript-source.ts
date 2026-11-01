import { he } from "@shared/locale";
import type { TranscriptRecord } from "@shared/types";

export function getTranscriptSourceKindLabel(transcript: TranscriptRecord): string {
  if (transcript.sourceType === "microphone") {
    return he.microphoneLabel;
  }

  if (transcript.sourceType === "youtube") {
    return he.youtubeLabel;
  }

  if (transcript.sourceType === "call") {
    return he.callLabel;
  }

  return he.importedLabel;
}

/** A name for lists and headings. A recording has none, so its opening words stand in. */
export function getTranscriptTitle(transcript: TranscriptRecord): string {
  if (transcript.sourceTitle) return transcript.sourceTitle;
  if (transcript.importedFileName) return transcript.importedFileName;
  if (transcript.sourceType === "youtube") return he.youtubeFallbackTitle;
  const opening = transcript.text.trim().split(/\s+/).slice(0, 8).join(" ");
  return opening || he.microphoneLabel;
}
