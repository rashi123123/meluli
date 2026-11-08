import { describe, expect, it } from "vitest";
import {
  estimateMicrophoneProcessingMs,
  getRemainingEstimateMs,
  recordProcessingTimingSample,
  refineProcessingEstimateMs
} from "@shared/processing-estimate";
import { appSettingsSchema } from "@shared/schemas";

describe("estimateMicrophoneProcessingMs", () => {
  it("returns a bounded estimate for microphone transcription", () => {
    expect(
      estimateMicrophoneProcessingMs({
        durationMs: 60_000,
        speedPreference: "balanced"
      })
    ).toBeGreaterThanOrEqual(10_000);

    expect(
      estimateMicrophoneProcessingMs({
        durationMs: 60_000,
        speedPreference: "balanced"
      })
    ).toBeLessThanOrEqual(120_000);
  });

  it("estimates slower processing when accuracy is preferred", () => {
    const fast = estimateMicrophoneProcessingMs({
      durationMs: 90_000,
      speedPreference: "balanced"
    });
    const slow = estimateMicrophoneProcessingMs({
      durationMs: 90_000,
      speedPreference: "accurate"
    });

    expect(slow).toBeGreaterThan(fast);
  });
});

describe("getRemainingEstimateMs", () => {
  it("subtracts elapsed processing time and never returns a negative value", () => {
    expect(
      getRemainingEstimateMs({
        processingStartedAt: 1_000,
        processingEstimateMs: 10_000,
        now: 4_000
      })
    ).toBe(7_000);

    expect(
      getRemainingEstimateMs({
        processingStartedAt: 1_000,
        processingEstimateMs: 10_000,
        now: 20_000
      })
    ).toBe(0);
  });
});

describe("refineProcessingEstimateMs", () => {
  it("tightens the estimate using live progress without dropping below elapsed time", () => {
    const refined = refineProcessingEstimateMs({
      processingStartedAt: 1_000,
      processingEstimateMs: 24_000,
      progressRatio: 0.5,
      now: 9_000
    });

    expect(refined).toBeGreaterThanOrEqual(8_750);
    expect(refined).toBeLessThan(24_000);
  });
});

describe("recordProcessingTimingSample", () => {
  it("learns from completed jobs while preserving the telemetry shape", () => {
    const initialTelemetry = appSettingsSchema.parse({}).processingTelemetry;
    const updated = recordProcessingTimingSample(initialTelemetry, {
      sourceType: "microphone",
      speedPreference: "balanced",
      durationMs: 10_000,
      setupMs: 4_000,
      totalElapsedMs: 8_500
    });

    expect(updated.microphone.balanced.sampleCount).toBe(1);
    expect(updated.microphone.balanced.averageSetupMs).toBe(4_000);
    expect(updated.microphone.balanced.averageMsPerAudioSecond).toBe(450);
    expect(updated.youtube.balanced.sampleCount).toBe(0);
  });
});
