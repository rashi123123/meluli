import { open } from "node:fs/promises";
import { speakerLabel } from "./calls/call-transcript";
import { getTranscriptCues, wrapCueText } from "@shared/transcript-cues";
import type { TranscriptRecord, TranscriptSegment } from "@shared/types";

function formatSrtTimestamp(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(secs).padStart(2, "0")
  ].join(":") + `,${String(milliseconds).padStart(3, "0")}`;
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function hasTranscriptSegments(transcript: TranscriptRecord | null | undefined): transcript is TranscriptRecord & {
  segments: TranscriptSegment[];
} {
  return Boolean(transcript?.segments && transcript.segments.length > 0);
}

export function buildTranscriptSrt(transcript: TranscriptRecord): string | null {
  if (!hasTranscriptSegments(transcript)) {
    return null;
  }

  const cues = getTranscriptCues(transcript);
  if (cues.length === 0) {
    return null;
  }

  return cues
    .map((segment, index) => [
      String(index + 1),
      `${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}`,
      segment.speaker ? `${speakerLabel(segment.speaker)}: ${segment.text}`
        : transcript.backend === "nemo" ? wrapCueText(segment.text) : segment.text
    ].join("\n"))
    .join("\n\n");
}

export function buildTranscriptSrtFileName(transcript: TranscriptRecord): string {
  const preferredName =
    transcript.sourceTitle ||
    transcript.importedFileName ||
    transcript.text.split(/\s+/).slice(0, 6).join(" ") ||
    transcript.id;

  const safeName = sanitizeFilePart(preferredName) || transcript.id;
  return `${safeName}.srt`;
}

/** Owner only, as the history is. An overwritten file keeps its mode unless changed, and some disks refuse the change. */
export async function writeTranscriptSrt(path: string, srt: string): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.chmod(0o600).catch(() => {});
    await file.writeFile(srt, "utf8");
  } finally {
    await file.close();
  }
}
