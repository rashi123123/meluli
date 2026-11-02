import type { TranscriptSegment } from "@shared/types";
import type { NormalizedTranscriptionResult, WorkerMessage } from "./transcription.service";

export function normalizeTranscriptSegments(rawSegments: unknown[] | null | undefined): TranscriptSegment[] | null {
  if (!Array.isArray(rawSegments)) {
    return null;
  }

  const normalized = rawSegments
    .map((segment) => {
      if (!segment || typeof segment !== "object") {
        return null;
      }

      const candidate = segment as Record<string, unknown>;
      if (
        typeof candidate.start !== "number" || !Number.isFinite(candidate.start) ||
        typeof candidate.end !== "number" || !Number.isFinite(candidate.end) ||
        typeof candidate.text !== "string"
      ) {
        return null;
      }

      const text = candidate.text.trim();
      if (!text) {
        return null;
      }

      return {
        start: Math.max(0, candidate.start),
        end: Math.max(Math.max(0, candidate.start), candidate.end),
        text
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);

  return normalized.length > 0 ? normalized : null;
}

export function normalizeTranscriptText(text: string | null | undefined, segments: TranscriptSegment[] | null): string {
  const direct = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (direct) {
    return direct;
  }

  if (!segments || segments.length === 0) {
    return "";
  }

  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTranscriptionResult(result: WorkerMessage & { type: "result" }): Omit<NormalizedTranscriptionResult, "backend" | "modelId"> {
  const segments = normalizeTranscriptSegments(result.result.segments ?? null);
  return {
    text: normalizeTranscriptText(result.result.text, segments),
    language: result.result.language?.trim() || "he",
    segments
  };
}
