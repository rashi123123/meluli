import { terminateChild } from "./terminate-child";
import { pipelineTrace } from "../diagnostics/pipeline-trace";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TranscriptionBackend, TranscriptionStartInput } from "@shared/types";
import { PRODUCT_ASR_ENGINE, type AsrEngine } from "../config/asr-engine";
import { minimalChildEnv } from "./child-env";
import { he } from "@shared/locale";
import { resolveWorkerBinary, type BinaryPaths } from "../config/paths";
import { SettingsService } from "./settings.service";
import {
  isLiveWorkerMessage,
  isSupportedReady,
  normalizeTranscriptionResult,
  progressPayload,
  workerProcessError,
  type NormalizedTranscriptionResult,
  type TranscriptionProgressPayload,
  type TranscribeRequest,
  type LiveRequest,
  type LiveWorkerMessage,
  type WarmupRequest,
  type WorkerMessage,
  type WorkerRequest
} from "./transcription-protocol";
import { TranscriptionCanceledError } from "./transcription-errors";
import { ProcessLines } from "./process-lines";
import { isMockMode } from "../config/mock-mode";
import { mockTranscription } from "./transcription-mock";

export type { TranscriptionProgressPayload } from "./transcription-protocol";

export interface TranscriptionDependencies {
  /** Isolated research configuration; absent in production. */
  workerEnv?: Record<string, string>;
  modelId?: string;
  getModelPath: () => Promise<string>;
  binaryPaths: BinaryPaths;
  /** The engine the worker runs, read at each spawn (the person's choice); the product engine when absent. */
  engine?: AsrEngine | (() => AsrEngine);
}

/** Hears a live dictation session on the worker (streaming engines only). */
export interface LiveChannelListener {
  message(message: LiveWorkerMessage): void;
  /** The worker went away; nothing more arrives for the session. */
  lost(): void;
}

export interface LiveChannel {
  modelPath: string;
  /** False when the worker is gone, the channel is closed, or the pipe is backed up. */
  send(request: LiveRequest): boolean;
  close(): void;
}

/** Live audio queued in the pipe beyond this means the worker cannot keep up. */
const LIVE_PIPE_LIMIT_BYTES = 4 * 1024 * 1024;

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
  /** A call piece can be all noise; it then has no words, which is not a failure. */
  allowEmpty: boolean;
  onProgress?: ((payload: TranscriptionProgressPayload) => void) | undefined;
}

export interface TranscribeOptions {
  onProgress?: (payload: TranscriptionProgressPayload) => void;
  /** Keeps the text when the model splits a letter. Only for work that is never pasted. */
  repairText?: boolean;
}

interface PendingWarmupJob {
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/** The native worker needs no setting from its environment. */
export function buildWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return minimalChildEnv(source);
}

/** The worker must say it is ready within this long of starting. */
const WORKER_READY_TIMEOUT_MS = 20_000;
/** A worker that answered within this long is not asked again before the next job. */
const HEALTH_FRESH_MS = 10_000;
const HEALTH_TIMEOUT_MS = 4_000;
const WARMUP_TIMEOUT_MS = 3 * 60_000;
/** A worker that does not confirm a cancel within this long is killed instead. */
const CANCEL_FALLBACK_MS = 1_500;

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

export class TranscriptionService {
  private idleTimer: NodeJS.Timeout | null = null;
  private operationCount = 0;
  private recordingActive = false;
  private transcriptionPending = false;
  private setupCanceled = false;
  private disposed = false;
  private workerOutput: ProcessLines | null = null;
  private worker: ChildProcessWithoutNullStreams | null = null;
  /** The engine the running worker was started for. */
  private workerEngine: AsrEngine | null = null;
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
  /** A user job waiting for the call piece to give way; a cancel meanwhile is meant for it. */
  private foregroundWait: { canceled: boolean } | null = null;
  /** The live dictation session's listener, while one is open. */
  private live: LiveChannelListener | null = null;

  constructor(
    private readonly dependencies: TranscriptionDependencies,
    private readonly settingsService: SettingsService
  ) {}

  setRecordingActive(active: boolean): void {
    if (this.recordingActive === active) return;
    this.recordingActive = active;
    if (active && this.backgroundRun) this.cancelCurrent();
    if (active) this.clearIdleTimer();
    else this.scheduleIdleRelease();
  }

  private get chosenEngine(): AsrEngine {
    const engine = this.dependencies.engine;
    return (typeof engine === "function" ? engine() : engine) ?? PRODUCT_ASR_ENGINE;
  }

  /** The running worker's engine, so a job's labels match the worker that ran it; otherwise the choice. */
  private get engine(): AsrEngine { return this.workerEngine ?? this.chosenEngine; }

  get backend(): TranscriptionBackend { return this.engine.backend; }

  get modelId(): string { return this.dependencies.modelId ?? `${this.engine.model.id}@${this.engine.model.revision}`; }

  /** Whether the chosen engine gives live sessions (the next dictation's engine). */
  get streaming(): boolean { return this.chosenEngine.streaming; }

  /**
   * Opens a live dictation session on the worker, starting it and loading the model first.
   * The worker stays up until `close()`; if it dies meanwhile the listener hears `lost()`.
   */
  async openLiveChannel(listener: LiveChannelListener): Promise<LiveChannel> {
    if (!this.chosenEngine.streaming) throw new Error(he.transcriptionProcessFailed);
    if (this.disposed) throw new TranscriptionCanceledError();
    this.operationCount += 1;
    this.clearIdleTimer();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (this.live === listener) this.live = null;
      this.operationCount -= 1;
      this.scheduleIdleRelease();
    };
    try {
      await this.prewarm();
      if (!this.worker) await this.ensureWorker();
      const modelPath = await this.dependencies.getModelPath();
      if (closed || this.disposed || !this.worker) throw new TranscriptionCanceledError();
      const worker = this.worker;
      const previous = this.live;
      this.live = listener;
      if (previous && previous !== listener) previous.lost();
      return {
        modelPath,
        close,
        send: (request) => {
          if (closed || this.live !== listener || this.worker !== worker || worker.stdin.destroyed) return false;
          if (worker.stdin.writableLength > LIVE_PIPE_LIMIT_BYTES) return false;
          worker.stdin.write(`${JSON.stringify(request)}\n`);
          return true;
        }
      };
    } catch (error) {
      close();
      throw error;
    }
  }

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
    this.restartWorker(new TranscriptionCanceledError());
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

  async transcribe(input: TranscriptionStartInput, options?: TranscribeOptions): Promise<NormalizedTranscriptionResult> {
    if (this.backgroundRun) {
      const wait = { canceled: false };
      this.foregroundWait = wait;
      this.cancelCurrent();
      try {
        await this.backgroundRun;
      } finally {
        if (this.foregroundWait === wait) this.foregroundWait = null;
      }
      if (wait.canceled) throw new TranscriptionCanceledError();
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

  private async reserve(input: TranscriptionStartInput, options?: TranscribeOptions): Promise<NormalizedTranscriptionResult> {
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

  private async runTranscription(input: TranscriptionStartInput, options?: TranscribeOptions): Promise<NormalizedTranscriptionResult> {
    if (isMockMode()) return mockTranscription(input, this.backend, this.modelId);

    const settings = this.settingsService.getSettings();
    const backend = this.backend;
    const modelId = this.modelId;
    console.log("[TranscriptionService] resolved transcription route", {
      sourceType: input.sourceType,
      backend,
      modelId
    });

    const model = { ...settings.modelState, filePath: await this.dependencies.getModelPath() };
    if (!model.filePath) {
      console.error("[TranscriptionService] modelState.filePath is missing");
      throw new Error(he.localModelMissingError);
    }

    if (this.activeJob) {
      throw new Error(he.transcriptionAlreadyRunning);
    }

    const startedAt = Date.now();
    const startingProgress: TranscriptionProgressPayload = { stage: "starting" };
    options?.onProgress?.(startingProgress);
    pipelineTrace("engine_ready_wait", "start", { workerRunning: Boolean(this.worker), warming: Boolean(this.prewarmPromise) });
    await this.ensureWorker();
    if (this.prewarmPromise) {
      try {
        await this.prewarm();
      } catch {
        // Let the real transcription attempt surface any model/runtime error.
      }
      // A worker that died while warming is replaced rather than handed the job.
      if (!this.worker) await this.ensureWorker();
    }
    pipelineTrace("engine_ready_wait", "end");

    if (this.setupCanceled || this.disposed) throw new TranscriptionCanceledError();
    const request: TranscribeRequest = {
      type: "transcribe", jobId: crypto.randomUUID(), wavPath: input.wavPath,
      modelPath: model.filePath, useGpu: settings.metalEnabled,
      ...(input.sourceType === "call" || options?.repairText ? { repairText: true } : {})
    };

    return new Promise((resolve, reject) => {
      const onSilence = () => {
        const currentJob = this.activeJob;
        if (!currentJob || currentJob.id !== request.jobId) {
          return;
        }

        const timeoutError = new Error(he.transcriptionProcessFailed);
        this.restartWorker(timeoutError);
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
        allowEmpty: input.sourceType === "call",
        onProgress: options?.onProgress
      };
      this.activeJob = job;

      try {
        this.sendWorkerMessage(request);
      } catch (error) {
        this.restartWorker(error instanceof Error ? error : new Error(he.transcriptionProcessFailed));
      }
    });
  }

  /** The user's cancel. While their job waits for a call piece to stop, it is their job that ends. */
  cancel(): boolean {
    if (this.foregroundWait) {
      this.foregroundWait.canceled = true;
      return true;
    }
    return this.cancelCurrent();
  }

  /** Cancels the job holding the worker now. */
  private cancelCurrent(): boolean {
    if (this.transcriptionPending && !this.activeJob) {
      this.setupCanceled = true;
      this.restartWorker(new TranscriptionCanceledError());
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
      this.restartWorker(new TranscriptionCanceledError());
    }, CANCEL_FALLBACK_MS);
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
    if (isMockMode()) {
      return;
    }

    const settings = this.settingsService.getSettings();
    const modelPath = await this.dependencies.getModelPath();
    if (!modelPath) {
      return;
    }

    await this.ensureWorker();
    // prewarm() lets one run at a time, so no other warmup can be waiting here.
    if (this.activeJob) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const jobId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        if (!this.pendingWarmupJob || this.pendingWarmupJob.id !== jobId) {
          return;
        }

        this.restartWorker(new Error(he.transcriptionProcessFailed));
      }, WARMUP_TIMEOUT_MS);

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
        this.restartWorker(error instanceof Error ? error : new Error(he.transcriptionProcessFailed));
      }
    });
  }

  private async ensureWorker(): Promise<void> {
    if (this.disposed || this.setupCanceled) throw new TranscriptionCanceledError();
    // The person chose another engine since this worker started (settings allow it only when idle).
    if (!this.worker || !this.readyPromise || this.workerEngine?.id !== this.chosenEngine.id) {
      this.spawnWorker();
      await this.readyPromise;
      return;
    }

    await this.readyPromise;
    if (Date.now() - this.lastHealthCheckAt < HEALTH_FRESH_MS) {
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
    // A job that asked to cancel ends as canceled, so a call piece is repeated rather than failed.
    this.teardownWorker(new Error(he.transcriptionProcessFailed), this.activeJob?.cancelRequested ? new TranscriptionCanceledError() : undefined);

    this.workerEngine = this.chosenEngine;
    const workerBinary = resolveWorkerBinary(this.dependencies.binaryPaths, this.engine.workerDir);
    console.log("[TranscriptionService] spawning transcription worker", {
      backend: this.engine.backend
    });
    const child = spawn(workerBinary, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...buildWorkerEnv(process.env), ...this.dependencies.workerEnv }
    });

    this.worker = child;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimeout = setTimeout(() => {
        reject(new Error(he.transcriptionProcessFailed));
        this.restartWorker(new Error(he.transcriptionProcessFailed));
      }, WORKER_READY_TIMEOUT_MS);
    });

    this.workerOutput = new ProcessLines(child.stdout);
    this.workerOutput.on("line", (line) => {
      if (this.worker === child) this.handleWorkerStdout(line);
    });
    child.stdin.on("error", () => {
      if (this.worker === child) this.restartWorker(new Error(he.transcriptionProcessFailed));
    });

    let lastStderrChunk: string | null = null;

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) {
        // Third-party diagnostics can contain filenames or recognized speech.
        lastStderrChunk = "Worker wrote diagnostics to stderr";
      }

      this.activeJob?.onProgress?.({ stage: "processing" });
    });

    child.on("error", (error) => {
      if (this.worker !== child) return;
      console.error("[TranscriptionService] worker process error", {
        kind: error instanceof Error ? error.name : "UnknownError"
      });
      this.restartWorker(error instanceof Error ? error : new Error(he.transcriptionProcessFailed));
    });

    child.on("close", (code, signal) => {
      if (this.worker !== child) return;
      const job = this.activeJob;
      console.error("[TranscriptionService] worker process exited", {
        code,
        signal,
        hadActiveJob: Boolean(job),
        lastStderrChunk
      });
      // A job that asked to cancel ends as canceled even though the worker died on the way.
      this.restartWorker(new Error(he.transcriptionProcessFailed), job?.cancelRequested ? new TranscriptionCanceledError() : undefined);
    });
  }

  /**
   * Drops the worker. Whatever was still waiting on it fails with `error` (the job with `jobError`),
   * so no caller is left waiting on a worker that is gone; the next request starts a new one.
   */
  private teardownWorker(error: Error = new Error(he.transcriptionProcessFailed), jobError: Error = error): void {
    const activeJob = this.activeJob;
    const warmupJob = this.pendingWarmupJob;
    const readyReject = this.readyReject;
    const healthReject = this.pendingHealth?.reject;
    const live = this.live;
    this.live = null;
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
    this.workerEngine = null;
    if (child && !child.killed) {
      child.removeAllListeners();
      child.on("error", () => undefined);
      terminateChild(child);
    }
    readyReject?.(error);
    healthReject?.(error);
    warmupJob?.reject(error);
    activeJob?.reject(jobError);
    live?.lost();
  }

  /** Drops the worker and fails everything waiting on it; the next request starts a new one. */
  private restartWorker(error: Error, jobError: Error = error): void {
    this.teardownWorker(error, jobError);
  }

  private async healthCheck(): Promise<void> {
    if (!this.worker || this.pendingHealth) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHealth = null;
        reject(new Error(he.transcriptionProcessFailed));
      }, HEALTH_TIMEOUT_MS);

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

    if (isLiveWorkerMessage(message)) {
      this.live?.message(message);
      return;
    }

    if (message.type === "ready") {
      if (!isSupportedReady(message, this.engine)) {
        this.restartWorker(new Error(he.transcriptionProcessFailed));
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

    if (warmupJob && "jobId" in message && message.jobId === warmupJob.id) {
      // A loading/progress message does not complete the warmup request.
      if (message.type !== "warmed" && message.type !== "error") return;
      clearTimeout(warmupJob.timeout);
      this.pendingWarmupJob = null;

      if (message.type === "error") {
        warmupJob.reject(workerProcessError(message.message));
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
      job.onProgress?.(progressPayload(message, job.startedAt));
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
      job.reject(workerProcessError(message.code === "invalid_utf8" ? he.transcriptionInvalidOutput : message.message));
      return;
    }

    if (message.type === "result") {
      pipelineTrace("worker_timing", "event", Object.fromEntries(
        Object.entries(message.timing ?? {}).filter(([, value]) => typeof value === "number")
      ));
      const normalized = normalizeTranscriptionResult(message);
      if (!normalized.text && job.allowEmpty) {
        job.resolve({ ...normalized, segments: [], backend: job.backend, modelId: job.modelId });
        return;
      }
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

  private sendWorkerMessage(payload: WorkerRequest): void {
    if (!this.worker || this.worker.stdin.destroyed) {
      throw new Error(he.transcriptionProcessFailed);
    }

    this.worker.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
