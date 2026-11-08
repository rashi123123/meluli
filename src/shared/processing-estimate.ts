import type {
  AppSettings,
  ProcessingTelemetry,
  ProcessingTelemetryBucket,
  SpeedPreference,
  TranscriptSegment,
  TranscriptionStartInput,
} from "./types";

const MIN_ESTIMATE_MS = 10_000;
const MAX_ESTIMATE_MS = 20 * 60_000;

export interface ProcessingTimingSample {
  sourceType: keyof ProcessingTelemetry;
  speedPreference: SpeedPreference;
  durationMs: number;
  setupMs: number;
  totalElapsedMs: number;
}

function clampEstimateMs(value: number): number {
  return Math.round(Math.max(MIN_ESTIMATE_MS, Math.min(MAX_ESTIMATE_MS, value)));
}

function getTelemetryBucket(
  telemetry: ProcessingTelemetry,
  sourceType: keyof ProcessingTelemetry,
  speedPreference: SpeedPreference
): ProcessingTelemetryBucket {
  return telemetry[sourceType][speedPreference];
}

export function estimateMicrophoneProcessingMs({
  durationMs,
  speedPreference,
  processingTelemetry
}: {
  durationMs: number | null | undefined;
  speedPreference: SpeedPreference;
  processingTelemetry?: ProcessingTelemetry | null;
}): number {
  return estimateProcessingMs({
    durationMs,
    sourceType: "microphone",
    speedPreference,
    processingTelemetry
  });
}

export function estimateProcessingMs({
  durationMs,
  sourceType,
  speedPreference,
  processingTelemetry
}: {
  durationMs: number | null | undefined;
  sourceType: keyof ProcessingTelemetry;
  speedPreference: SpeedPreference;
  processingTelemetry?: ProcessingTelemetry | null;
}): number {
  const safeDurationMs = Math.max(0, durationMs ?? 0);

  if (!processingTelemetry) {
    const fallbackMultiplier = speedPreference === "accurate" ? 1.12 : 1;
    return clampEstimateMs((safeDurationMs * 0.2 + 7_000) * fallbackMultiplier);
  }

  const bucket = getTelemetryBucket(processingTelemetry, sourceType, speedPreference);
  const estimate = bucket.averageSetupMs + (safeDurationMs / 1000) * bucket.averageMsPerAudioSecond;
  return clampEstimateMs(estimate);
}

export function refineProcessingEstimateMs({
  processingStartedAt,
  processingEstimateMs,
  progressRatio,
  now = Date.now()
}: {
  processingStartedAt: number | null | undefined;
  processingEstimateMs: number | null | undefined;
  progressRatio: number | null | undefined;
  now?: number;
}): number | null {
  if (!processingStartedAt || !processingEstimateMs || !progressRatio || progressRatio <= 0) {
    return processingEstimateMs ?? null;
  }

  const elapsedMs = Math.max(0, now - processingStartedAt);
  if (elapsedMs <= 0) {
    return processingEstimateMs;
  }

  const normalizedRatio = Math.max(0.02, Math.min(progressRatio, 0.98));
  const projectedTotalMs = elapsedMs / normalizedRatio;
  const weight =
    normalizedRatio < 0.12
      ? 0.2
      : normalizedRatio < 0.28
        ? 0.45
        : normalizedRatio < 0.55
          ? 0.65
          : 0.82;

  const blendedEstimate = processingEstimateMs * (1 - weight) + projectedTotalMs * weight;
  return clampEstimateMs(Math.max(elapsedMs + 750, blendedEstimate));
}

export function getRemainingEstimateMs({
  processingStartedAt,
  processingEstimateMs,
  now = Date.now()
}: {
  processingStartedAt: number | null | undefined;
  processingEstimateMs: number | null | undefined;
  now?: number;
}): number | null {
  if (!processingStartedAt || !processingEstimateMs) {
    return null;
  }

  const elapsedMs = Math.max(0, now - processingStartedAt);
  return Math.max(0, processingEstimateMs - elapsedMs);
}

export function recordProcessingTimingSample(
  telemetry: ProcessingTelemetry,
  sample: ProcessingTimingSample
): ProcessingTelemetry {
  if (!sample.durationMs || sample.durationMs <= 0 || sample.totalElapsedMs <= 0) {
    return telemetry;
  }

  const currentBucket = getTelemetryBucket(telemetry, sample.sourceType, sample.speedPreference);
  const boundedSetupMs = Math.max(250, Math.min(sample.setupMs, sample.totalElapsedMs));
  const processingOnlyMs = Math.max(500, sample.totalElapsedMs - boundedSetupMs);
  const measuredMsPerAudioSecond = Math.max(
    25,
    Math.min(20_000, processingOnlyMs / (sample.durationMs / 1000))
  );

  const alpha = currentBucket.sampleCount === 0 ? 1 : 0.25;
  const nextBucket: ProcessingTelemetryBucket = {
    sampleCount: Math.min(currentBucket.sampleCount + 1, 50),
    averageSetupMs: Math.round(currentBucket.averageSetupMs * (1 - alpha) + boundedSetupMs * alpha),
    averageMsPerAudioSecond: Math.round(
      currentBucket.averageMsPerAudioSecond * (1 - alpha) + measuredMsPerAudioSecond * alpha
    )
  };

  return {
    ...telemetry,
    [sample.sourceType]: {
      ...telemetry[sample.sourceType],
      [sample.speedPreference]: nextBucket
    }
  };
}

/** The audio length of a finished job: as recorded, as the worker measured it, or where its last segment ends. */
function jobDurationMs(input: TranscriptionStartInput, workerAudioMs: number | null, segments: TranscriptSegment[] | null | undefined): number | null {
  if (input.durationMs != null) return input.durationMs;
  if (workerAudioMs != null) return workerAudioMs;
  const lastSegment = segments?.at(-1);
  if (!lastSegment || typeof lastSegment.end !== "number" || lastSegment.end <= 0) return null;
  return Math.round(lastSegment.end * 1000);
}

/** The telemetry after one finished job, or null when the job says nothing about speed (a call, an unknown length). */
export function telemetryAfterJob(
  settings: Pick<AppSettings, "processingTelemetry" | "speedPreference">,
  input: TranscriptionStartInput,
  job: { processingStartedAt: number; workerAudioMs: number | null; setupMs: number; segments: TranscriptSegment[] | null | undefined },
  now = Date.now()
): ProcessingTelemetry | null {
  if (input.sourceType === "call") return null;
  const durationMs = jobDurationMs(input, job.workerAudioMs, job.segments);
  if (!durationMs || durationMs <= 0) return null;
  return recordProcessingTimingSample(settings.processingTelemetry, {
    sourceType: input.sourceType,
    speedPreference: settings.speedPreference,
    durationMs,
    setupMs: job.setupMs,
    totalElapsedMs: Math.max(1_000, now - job.processingStartedAt)
  });
}
