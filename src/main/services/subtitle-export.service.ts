import { open } from "node:fs/promises";
import { getTranscriptCues, wrapCueText } from "@shared/transcript-cues";
import { getTranscriptTitle } from "@shared/transcript-title";
import type { TranscriptExportFormat, TranscriptRecord, TranscriptSegment } from "@shared/types";
import { formatClock, speakerLabel } from "./transcript-format";

function formatTimestamp(seconds: number, separator: "," | "."): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(secs).padStart(2, "0")
  ].join(":") + `${separator}${String(milliseconds).padStart(3, "0")}`;
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

function cueBody(transcript: TranscriptRecord, segment: TranscriptSegment): string {
  return segment.speaker ? `${speakerLabel(segment.speaker)}: ${segment.text}`
    : transcript.backend === "nemo" ? wrapCueText(segment.text) : segment.text;
}

/** A blank line or "-->" inside a cue would end it early in SRT and WebVTT alike, so neither survives. */
function cueText(transcript: TranscriptRecord, segment: TranscriptSegment): string {
  return cueBody(transcript, segment).replace(/-->/g, "→").replace(/\n\s*\n/g, "\n");
}

function exportCues(transcript: TranscriptRecord): TranscriptSegment[] {
  return hasTranscriptSegments(transcript) ? getTranscriptCues(transcript) : [];
}

export function buildTranscriptSrt(transcript: TranscriptRecord): string | null {
  const cues = exportCues(transcript);
  if (cues.length === 0) return null;
  return cues
    .map((segment, index) => [
      String(index + 1),
      `${formatTimestamp(segment.start, ",")} --> ${formatTimestamp(segment.end, ",")}`,
      cueText(transcript, segment)
    ].join("\n"))
    .join("\n\n");
}

/** WebVTT for web players. Its cue text is markup, so & and < are written as entities. */
export function buildTranscriptVtt(transcript: TranscriptRecord): string | null {
  const cues = exportCues(transcript);
  if (cues.length === 0) return null;
  const body = cues.map((segment) => [
    `${formatTimestamp(segment.start, ".")} --> ${formatTimestamp(segment.end, ".")}`,
    cueText(transcript, segment).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  ].join("\n"));
  return ["WEBVTT", ...body].join("\n\n") + "\n";
}

function formatExportDate(timestamp: number): string {
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

/** Title, date and length, then the text as it reads in History. Calls keep their speaker and time per turn. */
export function buildTranscriptMarkdown(transcript: TranscriptRecord): string {
  const title = getTranscriptTitle(transcript).replace(/\s+/g, " ").trim();
  const details = [formatExportDate(transcript.createdAt)];
  if (transcript.durationMs) details.push(formatClock(Math.max(1, Math.round(transcript.durationMs / 1000))));
  const paragraphs = transcript.paragraphs?.length
    ? transcript.paragraphs
    : transcript.text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return [`# ${title}`, details.join(" · "), ...paragraphs].join("\n\n") + "\n";
}

export function buildTranscriptExport(transcript: TranscriptRecord, format: TranscriptExportFormat): string | null {
  if (format === "md") return buildTranscriptMarkdown(transcript);
  return format === "vtt" ? buildTranscriptVtt(transcript) : buildTranscriptSrt(transcript);
}

/** Formats this transcript can produce. Subtitles need timings. */
export function transcriptExportFormats(transcript: TranscriptRecord): TranscriptExportFormat[] {
  return exportCues(transcript).length > 0 ? ["md", "vtt", "srt"] : ["md"];
}

export function buildTranscriptFileName(transcript: TranscriptRecord, format: TranscriptExportFormat): string {
  const preferredName =
    transcript.sourceTitle ||
    transcript.importedFileName ||
    transcript.text.split(/\s+/).slice(0, 6).join(" ") ||
    transcript.id;

  const safeName = sanitizeFilePart(preferredName) || transcript.id;
  return `${safeName}.${format}`;
}

/** Owner only, as the history is. An overwritten file keeps its mode unless changed, and some disks refuse the change. */
export async function writeTranscriptFile(path: string, content: string): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.chmod(0o600).catch(() => {});
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}

