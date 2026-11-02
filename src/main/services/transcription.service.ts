import { pipelineTrace } from "../pipeline-trace";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type {
  TranscriptRecord,
  TranscriptSegment,
  TranscriptionBackend,
  TranscriptionStartInput,
  WorkerReadyV2,
  WorkerVadCapability
} from "@shared/types";
import { DEFAULT_TRANSCRIPTION_BACKEND, DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION, DEFAULT_MODEL_WEIGHT_FILE } from "@shared/constants";
import { formatCallText } from "./calls/call-transcript";
import { he } from "@shared/locale";
import { resolveWorkerCommand, type BinaryPaths } from "../config/paths";
import { SettingsService } from "./settings.service";
import { applyTerms, termMatcherForSettings } from "./term-replacement";
import { applySpokenCommands, resolveSpokenBreaks } from "./spoken-commands";
import { enhanceTranscript } from "./transcript-enhancer.service";
import { ProcessLines } from "./process-lines";

export interface NormalizedTranscriptionResult {
  text: string;
  language: string | null;
  segments: TranscriptSegment[] | null;
  backend: TranscriptionBackend;
  modelId: string;
}

interface WarmupRequest {
  type: "warmup";
  jobId: string;
  modelPath: string;
  useGpu?: boolean;
}

export interface TranscriptionProgressPayload {
  stage: "starting" | "processing";
  audioDurationMs?: number | null;
  processedAudioMs?: number | null;
  progressRatio?: number | null;
  setupElapsedMs?: number | null;
}

type WorkerMessage =
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
  | { type: "partial"; jobId: string; text?: string | null }
  | { type: "result"; jobId: string; result: { text?: string | null; language?: string | null; segments?: unknown[] | null }; timing?: Record<string, number> }
  | { type: "error"; jobId?: string; code?: string | null; message?: string | null }
  | { type: "canceled"; jobId: string };

export interface TranscriptionDependencies {
  /** Isolated research configuration; absent in production. */
  workerEnv?: Record<string, string>;
  modelId?: string;
  getModelPath?: () => Promise<string>;
  binaryPaths: BinaryPaths;
}

interface ActiveJob {
  id: string;
  startedAt: number;
  backend: TranscriptionBackend;
  modelId: string;
  resolve: (result: NormalizedTranscriptionResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  extendTimeout: () => void;
  cancelFallbackTimeout: NodeJS.Timeout | null;
  cancelRequested: boolean;
  onProgress?: ((payload: TranscriptionProgressPayload) => void) | undefined;
}

interface PendingWarmupJob {
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const validatedModelPathCache = new Set<string>();

export class TranscriptionCanceledError extends Error {
  constructor() {
    super(he.transcriptionCanceled);
    this.name = "TranscriptionCanceledError";
  }
}

export function isTranscriptionCanceledError(error: unknown): error is TranscriptionCanceledError {
  return error instanceof TranscriptionCanceledError || (
    error instanceof Error &&
    (error.message.includes("Transcription canceled.") || error.message.includes(he.transcriptionCanceled))
  );
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

function validateModelPath(modelPath: string): void {
  const path = modelPath.trim();
  if (validatedModelPathCache.has(path)) return;
  try {
    if (!path || !statSync(path).isDirectory() || !statSync(join(path, DEFAULT_MODEL_WEIGHT_FILE)).isFile()) {
      throw new Error(he.localModelMissingError);
    }
  } catch {
    throw new Error(he.localModelMissingError);
  }
  validatedModelPathCache.add(path);
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

export function isWorkerReadyV2(
  message: WorkerMessage & { type: "ready" }
): message is WorkerReadyV2 {
  return (
    typeof message.protocolVersion === "number" &&
    Number.isFinite(message.protocolVersion) &&
    typeof message.workerVersion === "string" &&
    (message.backend === "ct2" || message.backend === "whispercpp" || message.backend === "nemo") &&
    typeof message.capabilities?.vad?.supported === "boolean" &&
    (message.capabilities.vad.mode === "ct2_filter" || message.capabilities.vad.mode === "whispercpp_native" || message.capabilities.vad.mode === "none") &&
    typeof message.capabilities.vad.requiresModelPath === "boolean"
  );
}

// The native worker needs no setting from its environment. Anything else, such as DYLD_* or
// GGML_BACKEND_PATH, could load code into a process that sees everything the user dictates.
export function buildWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const key of ["HOME", "TMPDIR", "LANG"]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

function buildWorkerProcessError(message?: string | null): Error {
  if (message?.trim()) {
    return new Error(message.trim());
  }

  return new Error(he.transcriptionProcessFailed);
}

/** How long the worker may stay silent. It reports after every window of audio, so a long job runs for hours. */
function buildJobTimeoutMs(input: TranscriptionStartInput): number {
  if (!input.durationMs || input.durationMs <= 0) {
    // Large local models can take noticeable time to load on CPU; keep a generous floor.
    return 10 * 60_000;
  }

  const durationBound = input.durationMs * 8;
  return Math.max(5 * 60_000, Math.min(20 * 60_000, durationBound));
}

export const MODEL_IDLE_TIMEOUT_MS = 5 * 60_000;

export class TranscriptionService extends EventEmitter {
  private idleTimer: NodeJS.Timeout | null = null;
  private operationCount = 0;
  private recordingActive = false;
  private transcriptionPending = false;
  private setupCanceled = false;
  private disposed = false;
  private workerOutput: ProcessLines | null = null;
  private worker: ChildProcessWithoutNullStreams | null = null;
  private activeJob: ActiveJob | null = null;
  private pendingWarmupJob: PendingWarmupJob | null = null;
  private prewarmPromise: Promise<void> | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimeout: NodeJS.Timeout | null = null;
  private pendingHealth:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
      }
    | null = null;
  private lastHealthCheckAt = 0;
  /** A call piece in progress. Anything the user started goes first. */
  private backgroundRun: Promise<unknown> | null = null;

  constructor(
    private readonly dependencies: TranscriptionDependencies,
    private readonly settingsService: SettingsService
  ) {
    super();
  }

  setRecordingActive(active: boolean): void {
    if (this.recordingActive === active) return;
    this.recordingActive = active;
    if (active && this.backgroundRun) this.cancel();
    if (active) this.clearIdleTimer();
    else this.scheduleIdleRelease();
  }

  get backend(): TranscriptionBackend { return DEFAULT_TRANSCRIPTION_BACKEND; }

  get modelId(): string { return this.dependencies.modelId ?? DEFAULT_MODEL_ID + "@" + DEFAULT_MODEL_REVISION; }

  get isBusy(): boolean { return this.operationCount > 0 || this.recordingActive; }

  releaseIfIdle(): boolean {
    if (this.operationCount > 0 || this.recordingActive || !this.worker) return false;
    this.teardownWorker();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setupCanceled = true;
    this.clearIdleTimer();
    void this.restartWorker(new TranscriptionCanceledError());
    this.removeAllListeners();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleRelease(): void {
    this.clearIdleTimer();
    if (this.disposed || this.operationCount > 0 || this.recordingActive || !this.worker) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.releaseIfIdle();
    }, MODEL_IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  async transcribe(
    input: TranscriptionStartInput,
    options?: { onProgress?: (payload: TranscriptionProgressPayload) => void }
  ): Promise<NormalizedTranscriptionResult> {
    if (this.backgroundRun) {
      this.cancel();
      await this.backgroundRun;
    }
    return this.reserve(input, options);
  }

  /** Runs one piece of a call. It rejects as canceled when the user needs the model, and the caller repeats it. */
  async transcribeBackground(input: TranscriptionStartInput): Promise<NormalizedTranscriptionResult> {
    if (this.transcriptionPending || this.recordingActive) throw new TranscriptionCanceledError();
    const run = this.reserve(input);
    this.backgroundRun = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.backgroundRun = null;
    }
  }

  private async reserve(
    input: TranscriptionStartInput,
    options?: { onProgress?: (payload: TranscriptionProgressPayload) => void }
  ): Promise<NormalizedTranscriptionResult> {
    if (this.disposed) throw new TranscriptionCanceledError();
    // Reserve the job before awaiting worker startup or model warmup.
    if (this.transcriptionPending) throw new Error(he.transcriptionAlreadyRunning);
    this.transcriptionPending = true;
    this.setupCanceled = false;
    this.operationCount += 1;
    this.clearIdleTimer();
    try {
      return await this.runTranscription(input, options);
    } finally {
      this.transcriptionPending = false;
      this.operationCount -= 1;
      this.scheduleIdleRelease();
    }
  }

  private async runTranscription(
    input: TranscriptionStartInput,
    options?: { onProgress?: (payload: TranscriptionProgressPayload) => void }
  ): Promise<NormalizedTranscriptionResult> {
    if (process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1") {
      const text = input.sourceType === "youtube"
        ? `${he.mockTranscriptPrefix} ${input.sourceTitle ?? he.mockTranscriptVideoFallback}`
        : input.sourceType === "imported_file"
          ? `${he.mockTranscriptPrefix} ${input.importedFileName ?? he.mockTranscriptFileFallback}`
          : he.mockTranscriptLocal;

      return {
        text,
        language: "he",
        segments: [
          {
            start: 0,
            end: Math.max(2, Math.round((input.durationMs ?? 2_000) / 1000)),
            text
          }
        ],
        backend: DEFAULT_TRANSCRIPTION_BACKEND,
        modelId: DEFAULT_MODEL_ID + "@" + DEFAULT_MODEL_REVISION
      };
    }

    const settings = this.settingsService.getSettings();
    const backend = DEFAULT_TRANSCRIPTION_BACKEND;
    const modelId = this.dependencies.modelId ?? DEFAULT_MODEL_ID + "@" + DEFAULT_MODEL_REVISION;
    console.log("[TranscriptionService] resolved transcription route", {
      sourceType: input.sourceType,
      backend,
      modelId
    });

    const model = { ...settings.modelState, filePath: this.dependencies.getModelPath ? await this.dependencies.getModelPath() : settings.modelState.filePath };
    if (!model.filePath) {
      console.error("[TranscriptionService] modelState.filePath is missing");
      throw new Error(he.localModelMissingError);
    }

    if (!this.dependencies.getModelPath) validateModelPath(model.filePath);

    if (this.activeJob) {
      throw new Error(he.transcriptionAlreadyRunning);
    }

    const startedAt = Date.now();
    const startingProgress: TranscriptionProgressPayload = { stage: "starting" };
    this.emit("progress", startingProgress);
    options?.onProgress?.(startingProgress);
    pipelineTrace("engine_ready_wait", "start", { workerRunning: Boolean(this.worker), warming: Boolean(this.prewarmPromise || this.pendingWarmupJob) });
    await this.ensureWorker();
    if (this.prewarmPromise || this.pendingWarmupJob) {
      try {
        await this.prewarm();
      } catch {
        // Let the real transcription attempt surface any model/runtime error.
      }
    }
    pipelineTrace("engine_ready_wait", "end");

    if (this.setupCanceled || this.disposed) throw new TranscriptionCanceledError();
    const request = {
      type: "transcribe", jobId: crypto.randomUUID(), wavPath: input.wavPath,
      modelPath: model.filePath, useGpu: settings.metalEnabled,
      ...(input.sourceType === "call" ? { repairText: true } : {})
    };

    return new Promise((resolve, reject) => {
      const onSilence = () => {
        const currentJob = this.activeJob;
        if (!currentJob || currentJob.id !== request.jobId) {
          return;
        }

        const timeoutError = new Error(he.transcriptionProcessFailed);
        void this.restartWorker(timeoutError);
      };
      const timeoutMs = buildJobTimeoutMs(input);

      const job: ActiveJob = {
        id: request.jobId,
        startedAt,
        backend,
        modelId,
        resolve,
        reject,
        timeout: setTimeout(onSilence, timeoutMs),
        extendTimeout: () => {
          clearTimeout(job.timeout);
          job.timeout = setTimeout(onSilence, timeoutMs);
        },
        cancelFallbackTimeout: null,
        cancelRequested: false,
        onProgress: options?.onProgress
      };
      this.activeJob = job;

      try {
        this.sendWorkerMessage(request);
      } catch (error) {
        void this.restartWorker(error instanceof Error ? error : new Error(he.transcriptionProcessFailed));
      }
    });
  }

  cancel(): boolean {
    if (this.transcriptionPending && !this.activeJob) {
      this.setupCanceled = true;
      void this.restartWorker(new TranscriptionCanceledError());
      return true;
    }
    if (!this.worker || !this.activeJob) {
      return false;
    }

    if (this.activeJob.cancelRequested) {
      return true;
    }

    this.activeJob.cancelRequested = true;
    this.sendWorkerMessage({
      type: "cancel",
      jobId: this.activeJob.id
    });
    this.activeJob.cancelFallbackTimeout = setTimeout(() => {
      void this.restartWorker(new TranscriptionCanceledError());
    }, 1_500);
    return true;
  }

  async prewarm(): Promise<void> {
    if (this.disposed) throw new TranscriptionCanceledError();
    if (this.prewarmPromise) {
      return this.prewarmPromise;
    }

    if (!this.transcriptionPending) this.setupCanceled = false;
    this.operationCount += 1;
    this.clearIdleTimer();
    const prewarmTask = this.runPrewarm();
    this.prewarmPromise = prewarmTask;

    try {
      await prewarmTask;
    } finally {
      if (this.prewarmPromise === prewarmTask) {
        this.prewarmPromise = null;
      }
      this.operationCount -= 1;
      this.scheduleIdleRelease();
    }
  }

  private async runPrewarm(): Promise<void> {
    if (process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1") {
      return;
    }

    const settings = this.settingsService.getSettings();
    const modelPath = this.dependencies.getModelPath ? await this.dependencies.getModelPath() : settings.modelState.filePath;
    if (!modelPath) {
      return;
    }

    if (!this.dependencies.getModelPath) validateModelPath(modelPath);
    await this.ensureWorker();

    if (this.pendingWarmupJob) {
      await new Promise<void>((resolve, reject) => {
        const pending = this.pendingWarmupJob;
        if (!pending) {
          resolve();
          return;
        }

        const originalResolve = pending.resolve;
        const originalReject = pending.reject;
        pending.resolve = () => {
          originalResolve();
          resolve();
        };
        pending.reject = (error) => {
          originalReject(error);
          reject(error);
        };
      });
      return;
    }

    if (this.activeJob) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const jobId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        if (!this.pendingWarmupJob || this.pendingWarmupJob.id !== jobId) {
          return;
        }

        void this.restartWorker(new Error(he.transcriptionProcessFailed));
      }, 3 * 60_000);

      this.pendingWarmupJob = {
        id: jobId,
        resolve,
        reject,
        timeout
      };

      const request: WarmupRequest = {
        type: "warmup",
        jobId,
        modelPath,
        useGpu: settings.metalEnabled
      };
      try {
        this.sendWorkerMessage(request);
      } catch (error) {
        void this.restartWorker(error instanceof Error ? error : new Error(he.transcriptionProcessFailed));
      }
    });
  }

  buildTranscriptRecord(input: TranscriptionStartInput, result: NormalizedTranscriptionResult): TranscriptRecord {
    const settings = this.settingsService.getSettings();
    const terms = termMatcherForSettings(settings);
    // A lecture that says "סימן שאלה" means the words, so commands apply to dictation only.
    const spokenCommands = settings.spokenCommands && input.sourceType === "microphone";
    const enhanced = enhanceTranscript(result.text, {
      removeFillerWords: settings.removeFillerWords,
      terms,
      spokenCommands
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
        const turn = enhanceTranscript(text, { removeFillerWords: settings.removeFillerWords, terms });
        return (turn.text || turn.rawText).replace(/\s*\n+\s*/g, " ");
      };
      Object.assign(record, formatCallText(record.segments, clean), { rawText: formatCallText(result.segments ?? [], (text) => text).text });
    }

    console.log("[TranscriptionService] built transcript record", {
      sourceType: record.sourceType,
      backend: record.backend,
      modelId: record.modelId
    });

    return record;
  }

  private async ensureWorker(): Promise<void> {
    if (this.disposed || this.setupCanceled) throw new TranscriptionCanceledError();
    if (!this.worker || !this.readyPromise) {
      this.spawnWorker();
      await this.readyPromise;
      return;
    }

    await this.readyPromise;
    if (Date.now() - this.lastHealthCheckAt < 10_000) {
      return;
    }

    try {
      await this.healthCheck();
    } catch (error) {
      if (this.disposed || this.setupCanceled) throw error;
      this.spawnWorker();
      await this.readyPromise;
    }
  }

  private spawnWorker(): void {
    this.teardownWorker();

    const workerCommand = resolveWorkerCommand(this.dependencies.binaryPaths);
    console.log("[TranscriptionService] spawning transcription worker", {
      backend: DEFAULT_TRANSCRIPTION_BACKEND
    });
    const child = spawn(workerCommand.command, [...workerCommand.baseArgs, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...buildWorkerEnv(process.env), ...this.dependencies.workerEnv }
    });

    this.worker = child;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimeout = setTimeout(() => {
        reject(new Error(he.transcriptionProcessFailed));
        void this.restartWorker(new Error(he.transcriptionProcessFailed));
      }, 20_000);
    });

    this.workerOutput = new ProcessLines(child.stdout);
    this.workerOutput.on("line", (line) => {
      if (this.worker === child) this.handleWorkerStdout(line);
    });
    child.stdin.on("error", () => {
      if (this.worker === child) void this.restartWorker(new Error(he.transcriptionProcessFailed));
    });

    let lastStderrChunk: string | null = null;

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) {
        // Third-party diagnostics can contain filenames or recognized speech.
        lastStderrChunk = "Worker wrote diagnostics to stderr";
      }

      const payload: TranscriptionProgressPayload = { stage: "processing" };
      this.emit("progress", payload);
      this.activeJob?.onProgress?.(payload);
    });

    child.on("error", (error) => {
      if (this.worker !== child) return;
      console.error("[TranscriptionService] worker process error", {
        kind: error instanceof Error ? error.name : "UnknownError"
      });
      void this.restartWorker(error instanceof Error ? error : new Error(he.transcriptionProcessFailed));
    });

    child.on("close", (code, signal) => {
      if (this.worker !== child) return;
      const job = this.activeJob;
      const warmupJob = this.pendingWarmupJob;
      const initReject = this.readyReject;
      const healthReject = this.pendingHealth?.reject;

      console.error("[TranscriptionService] worker process exited", {
        code,
        signal,
        hadActiveJob: Boolean(job),
        lastStderrChunk
      });

      this.teardownWorker();

      if (initReject) {
        initReject(new Error(he.transcriptionProcessFailed));
      }
      if (healthReject) {
        healthReject(new Error(he.transcriptionProcessFailed));
      }
      if (warmupJob) {
        warmupJob.reject(new Error(he.transcriptionProcessFailed));
      }
      if (job) {
        job.reject(job.cancelRequested ? new TranscriptionCanceledError() : new Error(he.transcriptionProcessFailed));
      }
    });
  }

  private teardownWorker(): void {
    this.clearIdleTimer();
    this.workerOutput?.close();
    this.workerOutput = null;
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    if (this.pendingHealth) {
      clearTimeout(this.pendingHealth.timeout);
      this.pendingHealth = null;
    }
    if (this.pendingWarmupJob) {
      clearTimeout(this.pendingWarmupJob.timeout);
      this.pendingWarmupJob = null;
    }

    if (this.activeJob?.timeout) {
      clearTimeout(this.activeJob.timeout);
    }
    if (this.activeJob?.cancelFallbackTimeout) {
      clearTimeout(this.activeJob.cancelFallbackTimeout);
    }

    this.activeJob = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.lastHealthCheckAt = 0;

    const child = this.worker;
    this.worker = null;
    if (child && !child.killed) {
      child.removeAllListeners();
      child.on("error", () => undefined);
      child.kill("SIGTERM");
      const killFallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      killFallback.unref();
      child.once("close", () => clearTimeout(killFallback));
    }
  }

  private async restartWorker(error: Error): Promise<void> {
    const activeJob = this.activeJob;
    const warmupJob = this.pendingWarmupJob;
    const readyReject = this.readyReject;
    const healthReject = this.pendingHealth?.reject;
    this.teardownWorker();
    readyReject?.(error);
    healthReject?.(error);
    warmupJob?.reject(error);
    activeJob?.reject(error);
  }

  private async healthCheck(): Promise<void> {
    if (!this.worker || this.pendingHealth) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHealth = null;
        reject(new Error(he.transcriptionProcessFailed));
      }, 4_000);

      this.pendingHealth = {
        resolve: () => {
          clearTimeout(timeout);
          this.pendingHealth = null;
          this.lastHealthCheckAt = Date.now();
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.pendingHealth = null;
          reject(error);
        },
        timeout
      };

      this.sendWorkerMessage({ type: "health" });
    });
  }

  private handleWorkerStdout(line: string): void {
    let message: WorkerMessage | null = null;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch (error) {
      console.error("[TranscriptionService] failed to parse worker stdout JSON", {
        byteLength: Buffer.byteLength(line),
        error: error instanceof Error ? error.name : "InvalidJson"
      });
      return;
    }

    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      console.error("[TranscriptionService] ignored non-object worker stdout", { byteLength: Buffer.byteLength(line) });
      return;
    }

    if (message.type === "ready") {
      if (!isWorkerReadyV2(message) || message.protocolVersion !== 2 || message.backend !== DEFAULT_TRANSCRIPTION_BACKEND) {
        void this.restartWorker(new Error(he.transcriptionProcessFailed));
        return;
      }
      console.log("[TranscriptionService] worker ready", {
        backend: message.backend,
        protocolVersion: message.protocolVersion,
        workerVersion: message.workerVersion,
        vadCapability: message.capabilities.vad
      });
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }
      this.lastHealthCheckAt = Date.now();
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    if (message.type === "health") {
      this.pendingHealth?.resolve();
      return;
    }

    const warmupJob = this.pendingWarmupJob;

    // Backward compatibility: older worker builds may emit a generic error
    // for unsupported "warmup" requests without including a jobId.
    if (warmupJob && message.type === "error" && !("jobId" in message)) {
      clearTimeout(warmupJob.timeout);
      this.pendingWarmupJob = null;
      warmupJob.reject(buildWorkerProcessError(message.message));
      return;
    }
    if (warmupJob && "jobId" in message && message.jobId === warmupJob.id) {
      // A loading/progress message does not complete the warmup request.
      if (message.type !== "warmed" && message.type !== "error") return;
      clearTimeout(warmupJob.timeout);
      this.pendingWarmupJob = null;

      if (message.type === "error") {
        warmupJob.reject(buildWorkerProcessError(message.message));
        return;
      }

      if (message.type === "warmed") {
        warmupJob.resolve();
        return;
      }
    }

    const job = this.activeJob;
    if (!job || ("jobId" in message && message.jobId !== job.id)) {
      return;
    }

    if (message.type === "progress") {
      job.extendTimeout();
      const payload: TranscriptionProgressPayload = {
        stage: message.stage === "processing" ? "processing" : "starting",
        audioDurationMs:
          typeof message.audioDurationSec === "number" && Number.isFinite(message.audioDurationSec)
            ? Math.round(Math.max(0, message.audioDurationSec) * 1000)
            : null,
        processedAudioMs:
          typeof message.processedAudioSec === "number" && Number.isFinite(message.processedAudioSec)
            ? Math.round(Math.max(0, message.processedAudioSec) * 1000)
            : null,
        progressRatio:
          typeof message.progressRatio === "number" && Number.isFinite(message.progressRatio)
            ? Math.max(0, Math.min(1, message.progressRatio))
            : null,
        setupElapsedMs:
          message.stage === "processing"
            ? Math.max(0, Date.now() - job.startedAt)
            : null
      };
      this.emit("progress", payload);
      job.onProgress?.(payload);
      return;
    }

    if (message.type === "partial") {
      // Partial text updates are informational and should not settle the job.
      return;
    }

    if (message.type !== "canceled" && message.type !== "error" && message.type !== "result") {
      // Ignore unknown non-terminal messages for forward compatibility.
      return;
    }

    clearTimeout(job.timeout);
    if (job.cancelFallbackTimeout) {
      clearTimeout(job.cancelFallbackTimeout);
    }
    this.activeJob = null;

    if (message.type === "canceled" || job.cancelRequested) {
      job.reject(new TranscriptionCanceledError());
      return;
    }

    if (message.type === "error") {
      job.reject(buildWorkerProcessError(message.code === "invalid_utf8" ? he.transcriptionInvalidOutput : message.message));
      return;
    }

    if (message.type === "result") {
      pipelineTrace("worker_timing", "event", Object.fromEntries(
        Object.entries(message.timing ?? {}).filter(([, value]) => typeof value === "number")
      ));
      const normalized = normalizeTranscriptionResult(message);
      if (!normalized.text) {
        job.reject(new Error(he.transcriptionEmptyResult));
        return;
      }

      job.resolve({
        ...normalized,
        backend: job.backend,
        modelId: job.modelId
      });
    }
  }

  private sendWorkerMessage(payload: unknown): void {
    if (!this.worker || this.worker.stdin.destroyed) {
      throw new Error(he.transcriptionProcessFailed);
    }

    this.worker.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
