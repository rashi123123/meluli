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
