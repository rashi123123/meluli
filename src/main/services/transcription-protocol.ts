// The workers' line protocol (native/whisper-worker.cpp, v2; native/stream-worker.cpp, v3 with live sessions):
// the requests they take, the messages they send, and the checks that turn a result into the app's transcript
// shape. One JSON object per line each way.
import type { TranscriptSegment, TranscriptionBackend, WorkerReadyV2, WorkerVadCapability } from "@shared/types";
import { he } from "@shared/locale";

export interface NormalizedTranscriptionResult {
  text: string;
  language: string | null;
  segments: TranscriptSegment[] | null;
  backend: TranscriptionBackend;
  modelId: string;
}

/** The protocol version this app speaks; a worker that reports another is restarted. */
export const WORKER_PROTOCOL_VERSION = 2;

export interface WarmupRequest {
  type: "warmup";
  jobId: string;
  modelPath: string;
  useGpu?: boolean;
}

export interface TranscribeRequest {
  type: "transcribe";
  jobId: string;
  wavPath: string;
  modelPath: string;
  useGpu: boolean;
  /** Calls only: the worker repairs common call-audio text artefacts. */
  repairText?: true;
}

/** Live dictation requests (protocol v3). `pcm` is base64 s16le mono at 16 kHz. */
export type LiveRequest =
  | { type: "begin"; sessionId: string; modelPath: string }
  | { type: "audio"; sessionId: string; seq: number; pcm: string }
  | { type: "finish"; sessionId: string; samples: number }
  | { type: "cancel_session"; sessionId: string };

export type WorkerRequest =
  | TranscribeRequest
  | WarmupRequest
  | LiveRequest
  | { type: "cancel"; jobId: string }
  | { type: "health" };

export interface LiveSegment { index: number; start: number; end: number; text: string }

/** What the streaming worker says about a live session. */
export type LiveWorkerMessage =
  | { type: "begun"; sessionId: string }
  | { type: "partial"; sessionId: string; seq: number; text: string; segments: number }
  | { type: "segment"; sessionId: string; segment: LiveSegment }
  | { type: "final"; sessionId: string; result: { text?: string | null; language?: string | null; segments?: unknown[] | null }; timing?: Record<string, number> }
  | { type: "canceled"; sessionId: string }
  | { type: "error"; sessionId: string; code?: string | null; message?: string | null };

export type WorkerMessage =
  | {
      type: "ready";
      protocolVersion?: number;
      workerVersion?: string;
      backend?: TranscriptionBackend;
      capabilities?: {
        vad?: {
          supported?: boolean;
          mode?: WorkerVadCapability["mode"];
          requiresModelPath?: boolean;
        };
      };
    }
  | { type: "health"; ok: true }
  | { type: "warmed"; jobId: string }
  | {
      type: "progress";
      jobId: string;
      stage: "loading" | "processing";
      audioDurationSec?: number | null;
      processedAudioSec?: number | null;
      progressRatio?: number | null;
    }
  | { type: "result"; jobId: string; result: { text?: string | null; language?: string | null; segments?: unknown[] | null }; timing?: Record<string, number> }
  | { type: "error"; jobId?: string; code?: string | null; message?: string | null }
  | { type: "canceled"; jobId: string };

export function isWorkerReadyV2(
  message: WorkerMessage & { type: "ready" }
): message is WorkerReadyV2 {
  return (
    typeof message.protocolVersion === "number" &&
    Number.isFinite(message.protocolVersion) &&
    typeof message.workerVersion === "string" &&
    (message.backend === "whispercpp" || message.backend === "sherpa-onnx") &&
    typeof message.capabilities?.vad?.supported === "boolean" &&
    (message.capabilities.vad.mode === "ct2_filter" || message.capabilities.vad.mode === "whispercpp_native" || message.capabilities.vad.mode === "none") &&
    typeof message.capabilities.vad.requiresModelPath === "boolean"
  );
}

/** A ready message from the worker this app started: well formed, the expected engine, and its protocol version. */
export function isSupportedReady(
  message: WorkerMessage & { type: "ready" },
  expected: { backend: TranscriptionBackend; protocolVersion: number } = { backend: "whispercpp", protocolVersion: WORKER_PROTOCOL_VERSION }
): message is WorkerReadyV2 {
  return isWorkerReadyV2(message) && message.backend === expected.backend && message.protocolVersion === expected.protocolVersion;
}

export function isLiveWorkerMessage(message: object): message is LiveWorkerMessage {
  return "sessionId" in message && typeof (message as { sessionId: unknown }).sessionId === "string";
}

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

export function normalizeTranscriptionResult<T extends { result: { text?: string | null; language?: string | null; segments?: unknown[] | null } }>(result: T): Omit<NormalizedTranscriptionResult, "backend" | "modelId"> {
  const segments = normalizeTranscriptSegments(result.result.segments ?? null);
  return {
    text: normalizeTranscriptText(result.result.text, segments),
    language: result.result.language?.trim() || "he",
    segments
  };
}

/** What the app shows while a job runs: the worker's progress message, checked and in milliseconds. */
export interface TranscriptionProgressPayload {
  stage: "starting" | "processing";
  audioDurationMs?: number | null;
  progressRatio?: number | null;
  setupElapsedMs?: number | null;
}

export function progressPayload(message: WorkerMessage & { type: "progress" }, startedAt: number): TranscriptionProgressPayload {
  return {
    stage: message.stage === "processing" ? "processing" : "starting",
    audioDurationMs:
      typeof message.audioDurationSec === "number" && Number.isFinite(message.audioDurationSec)
        ? Math.round(Math.max(0, message.audioDurationSec) * 1000)
        : null,
    progressRatio:
      typeof message.progressRatio === "number" && Number.isFinite(message.progressRatio)
        ? Math.max(0, Math.min(1, message.progressRatio))
        : null,
    setupElapsedMs: message.stage === "processing" ? Math.max(0, Date.now() - startedAt) : null
  };
}

/** The worker's own message when it gave one, otherwise the generic failure. */
export function workerProcessError(message?: string | null): Error {
  return new Error(message?.trim() ? message.trim() : he.transcriptionProcessFailed);
}
