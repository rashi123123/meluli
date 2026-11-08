// The transcript a mock run (IVRIT_E2E_MOCK / IVRIT_USE_MOCK_SERVICES) returns instead of running the worker.
import type { TranscriptionStartInput } from "@shared/types";
import { he } from "@shared/locale";
import type { NormalizedTranscriptionResult } from "./transcription-protocol";

export function mockTranscription(input: TranscriptionStartInput, backend: NormalizedTranscriptionResult["backend"], modelId: string): NormalizedTranscriptionResult {
  const text = input.sourceType === "youtube"
    ? `${he.mockTranscriptPrefix} ${input.sourceTitle ?? he.mockTranscriptVideoFallback}`
    : input.sourceType === "imported_file"
      ? `${he.mockTranscriptPrefix} ${input.importedFileName ?? he.mockTranscriptFileFallback}`
      : he.mockTranscriptLocal;
  return {
    text,
    language: "he",
    segments: [{ start: 0, end: Math.max(2, Math.round((input.durationMs ?? 2_000) / 1000)), text }],
    backend,
    modelId
  };
}
