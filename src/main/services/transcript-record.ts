import type { AppSettings, TranscriptionStartInput, TranscriptRecord } from "@shared/types";
import { formatCallText } from "./calls/call-transcript";
import { termMatcherForSettings } from "./text-rules/term-lexicon";
import { applyTerms } from "./text-rules/term-replacement";
import { applySpokenCommands, resolveSpokenBreaks } from "./text-rules/spoken-commands";
import { enhanceTranscript } from "./text-rules/transcript-enhancer.service";
import type { NormalizedTranscriptionResult } from "./transcription-protocol";

/** What the worker heard, turned into the saved transcript under the user's text settings. */
export function buildTranscriptRecord(settings: AppSettings, input: TranscriptionStartInput, result: NormalizedTranscriptionResult): TranscriptRecord {
  const terms = termMatcherForSettings(settings);
  // A lecture that says "סימן שאלה" means the words, so commands apply to dictation only.
  const spokenCommands = settings.spokenCommands && input.sourceType === "microphone";
  const enhanced = enhanceTranscript(result.text, {
    removeFillerWords: settings.removeFillerWords,
    numbersAsDigits: settings.numbersAsDigits,
    terms,
    spokenCommands,
    segments: result.segments
  });

  const record: TranscriptRecord = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    sourceType: input.sourceType,
    text: enhanced.text || enhanced.rawText,
    rawText: enhanced.rawText,
    paragraphs: enhanced.paragraphs,
    importedFileName: input.importedFileName ?? null,
    sourceTitle: input.sourceTitle ?? null,
    sourceUrl: input.sourceUrl ?? null,
    possibleTerms: enhanced.possibleTerms,
    uncertainSegments: enhanced.uncertainSegments,
    durationMs: input.durationMs ?? null,
    backend: result.backend,
    modelId: result.modelId,
    language: result.language ?? "he",
    segments: result.segments?.map((segment) => {
      const text = applyTerms(segment.text, terms);
      return { ...segment, text: spokenCommands ? resolveSpokenBreaks(applySpokenCommands(text)) : text };
    }) ?? null
  };

  if (input.sourceType === "call" && record.segments) {
    const clean = (text: string) => {
      const turn = enhanceTranscript(text, { removeFillerWords: settings.removeFillerWords, numbersAsDigits: settings.numbersAsDigits, terms });
      return (turn.text || turn.rawText).replace(/\s*\n+\s*/g, " ");
    };
    Object.assign(record, formatCallText(record.segments, clean), { rawText: formatCallText(result.segments ?? [], (text) => text).text });
  }

  console.log("[TranscriptRecord] built", {
    sourceType: record.sourceType,
    backend: record.backend,
    modelId: record.modelId
  });

  return record;
}
