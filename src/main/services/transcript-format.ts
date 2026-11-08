import { he } from "@shared/locale";
import type { CallSpeaker } from "@shared/types";

/** How exported and copied transcripts name a speaker and write a time: 01:12, or 1:02:03 past an hour. */
export function speakerLabel(speaker: CallSpeaker): string {
  return speaker === "me" ? he.callSpeakerMe : he.callSpeakerOthers;
}

export function formatClock(totalSeconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(totalSeconds / 3600);
  const clock = `${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}
