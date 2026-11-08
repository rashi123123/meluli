/* @vitest-environment node */

import { afterEach, describe, expect, it, vi } from "vitest";
import { he } from "@shared/locale";
import { appSettingsSchema } from "@shared/schemas";
import { buildTranscriptRecord } from "@main/services/transcript-record";
import { TranscriptionService } from "@main/services/transcription.service";
import { TranscriptionCanceledError } from "@main/services/transcription-errors";
import { isWorkerReadyV2, normalizeTranscriptSegments, normalizeTranscriptText, normalizeTranscriptionResult } from "@main/services/transcription-protocol";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeTranscriptSegments", () => {
  it("drops invalid segments and trims text", () => {
    expect(
      normalizeTranscriptSegments([
        { start: 0, end: 1.25, text: " שלום " },
        { bad: true },
        { start: 2, end: 3, text: "" }
      ])
    ).toEqual([
      {
        start: 0,
        end: 1.25,
        text: "שלום"
      }
    ]);
  });
});

describe("normalizeTranscriptText", () => {
  it("falls back to segment text when direct text is missing", () => {
    expect(
      normalizeTranscriptText("", [
        { start: 0, end: 1, text: "שלום" },
        { start: 1, end: 2, text: "עולם" }
      ])
    ).toBe("שלום עולם");
  });
});

describe("normalizeTranscriptionResult", () => {
  it("preserves the output shape expected by downstream code", () => {
    expect(
      normalizeTranscriptionResult({
        type: "result",
        jobId: "job-1",
        result: {
          text: "שלום עולם",
          language: "he",
          segments: [{ start: 0, end: 1.5, text: "שלום עולם" }]
        }
      })
    ).toEqual({
      text: "שלום עולם",
      language: "he",
      segments: [{ start: 0, end: 1.5, text: "שלום עולם" }]
    });
  });
});

describe("worker ready contract", () => {
  it("accepts the minimal v2 ready contract", () => {
    expect(isWorkerReadyV2({
      type: "ready",
      protocolVersion: 2,
      workerVersion: "meluli-whisper-worker",
      backend: "whispercpp",
      capabilities: { vad: { supported: false, mode: "none", requiresModelPath: false } }
    })).toBe(true);
  });

  it("rejects a ready message without the v2 contract", () => {
    expect(isWorkerReadyV2({ type: "ready" })).toBe(false);
  });
});

describe("TranscriptionCanceledError", () => {
  it("still uses the same Hebrew cancellation message", () => {
    expect(new TranscriptionCanceledError().message).toBe(he.transcriptionCanceled);
  });
});

describe("a model that is not ready", () => {
  const service = () => new TranscriptionService({
    getModelPath: () => Promise.reject(new Error(he.localModelMissingError)),
    binaryPaths: { resourcesBasePath: "/tmp/resources", whispercppWorkerBinaryPath: "/tmp/whispercpp-worker", ytDlpBinaryPath: "", denoBinaryPath: "" }
  }, { getSettings: () => appSettingsSchema.parse({}) } as never);

  it("stops a transcription with the model manager's message", async () => {
    await expect(service().transcribe({ wavPath: "/tmp/fixture.wav", sourceType: "microphone" })).rejects.toThrow(he.localModelMissingError);
  });

  it("hands the same failure to the prewarm caller, which catches it", async () => {
    await expect(service().prewarm()).rejects.toThrow(he.localModelMissingError);
  });
});

describe("buildTranscriptRecord", () => {
  it("persists the actual backend and model id", () => {
    const settings = appSettingsSchema.parse({
      removeFillerWords: false
    });

    const record = buildTranscriptRecord(settings,
      {
        wavPath: "/tmp/input.wav",
        sourceType: "imported_file",
        importedFileName: "input.wav"
      },
      {
        text: "שלום עולם",
        language: "he",
        segments: [{ start: 0, end: 1.5, text: "שלום עולם" }],
        backend: "whispercpp",
        modelId: "ivrit-ai/whisper-large-v3-turbo-ggml"
      }
    );

    expect(record.backend).toBe("whispercpp");
    expect(record.modelId).toBe("ivrit-ai/whisper-large-v3-turbo-ggml");
  });

  it("corrects the text and the cues, and keeps the raw text", () => {
    const settings = appSettingsSchema.parse({
      dictionary: [{ id: "1", heard: "מלולי", written: "Meluli" }]
    });

    const record = buildTranscriptRecord(settings,
      { wavPath: "/tmp/input.wav", sourceType: "microphone" },
      {
        text: "פתחתי את קלוד אמדי ואת מלולי",
        language: "he",
        segments: [{ start: 0, end: 1.5, text: "פתחתי את קלוד אמדי ואת מלולי" }],
        backend: "whispercpp",
        modelId: "ivrit-ai/whisper-large-v3-turbo-ggml"
      }
    );

    expect(record.text).toContain("CLAUDE.md");
    expect(record.text).toContain("ואת Meluli");
    expect(record.segments?.[0]?.text).toContain("CLAUDE.md");
    expect(record.rawText).toBe("פתחתי את קלוד אמדי ואת מלולי");
  });

  it("labels call transcripts and keeps the speaker on every segment", () => {
    const settings = appSettingsSchema.parse({ removeFillerWords: false, spokenCommands: true });
    const record = buildTranscriptRecord(settings, { wavPath: "", sourceType: "call", durationMs: 60_000 }, {
      text: "שלום סימן שאלה מה נשמע",
      language: "he",
      backend: "whispercpp",
      modelId: "model",
      segments: [
        { start: 12, end: 14, text: "שלום סימן שאלה", speaker: "me" },
        { start: 15, end: 16, text: "מה נשמע", speaker: "others" }
      ]
    });
    expect(record.text).toContain("[00:12] אני: שלום סימן שאלה");
    expect(record.text).toContain("[00:15] משתתפים: מה נשמע");
    expect(record.paragraphs).toHaveLength(2);
    expect(record.segments?.map((segment) => segment.speaker)).toEqual(["me", "others"]);
  });
});
