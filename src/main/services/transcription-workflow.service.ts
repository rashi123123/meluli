import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { Notification, BrowserWindow } from "electron";
import { getHebrewErrorMessage } from "@shared/error-utils";
import {
  estimateMicrophoneProcessingMs,
  recordProcessingTimingSample,
  refineProcessingEstimateMs
} from "@shared/processing-estimate";
import { transcriptRecordSchema, transcriptionErrorPayloadSchema } from "@shared/schemas";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { he } from "@shared/locale";
import type {
  AppSettings,
  TranscriptSegment,
  RecordingAudioPayload,
  TranscriptRecord,
  TranscriptionStartInput
} from "@shared/types";
import type { AppDatabase } from "../db/database";
import { markPerformanceAudit } from "../perf-audit";
import { AudioConverterService } from "./audio-converter.service";
import { SettingsService } from "./settings.service";
import {
  buildTranscriptCompletionNotification,
  shouldNotifyTranscriptCompletion
} from "./transcript-notification.service";
import {
  isTranscriptionCanceledError,
  TranscriptionCanceledError,
  TranscriptionService
} from "./transcription.service";
import type { NormalizedTranscriptionResult } from "./transcription.service";
import { AppRuntime } from "../runtime";
import { TextInsertionError, TextInsertionService } from "./text-insertion.service";
import { beginPipelineTrace, pipelineTrace } from "../pipeline-trace";
import type { InsertionJournal } from "./insertion-journal";

const WAV_ENCODER_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");

function encodeWavFromFloat32Buffer(pcmBuffer, sampleRate) {
  const pcm = new Float32Array(pcmBuffer);
  const wavBuffer = new ArrayBuffer(44 + pcm.length * 2);
  const buffer = Buffer.from(wavBuffer);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcm.length * 2, 40);

  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] || 0));
    buffer.writeInt16LE(Math.round(sample * 0x7fff), 44 + index * 2);
  }
  return wavBuffer;
}

parentPort.on("message", ({ pcmBuffer, sampleRate }) => {
  try {
    if (!(pcmBuffer instanceof ArrayBuffer)) {
      throw new Error("Expected audio PCM as an ArrayBuffer.");
    }

    const wavBuffer = encodeWavFromFloat32Buffer(pcmBuffer, sampleRate);
    parentPort.postMessage({ wavBuffer }, [wavBuffer]);
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
`;

function normalizeRecordingPcm(pcm: RecordingAudioPayload["pcm"]): Float32Array {
  if (pcm instanceof Float32Array) {
    return pcm;
  }

  if (pcm instanceof ArrayBuffer) {
    return new Float32Array(pcm);
  }

  return Float32Array.from(pcm);
}

function toTransferableArrayBuffer(view: Float32Array): ArrayBuffer {
  if (view.buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer;
  }

  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

async function encodeWavFromRecordingPayload(payload: RecordingAudioPayload, signal: AbortSignal): Promise<Buffer> {
  markPerformanceAudit("recording-audio:encode:start", {
    durationMs: Math.round(payload.durationMs),
    sampleRate: payload.sampleRate
  });
  const pcmBuffer = toTransferableArrayBuffer(normalizeRecordingPcm(payload.pcm));

  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(WAV_ENCODER_WORKER_SOURCE, { eval: true });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const aborted = () => settleWithError(new TranscriptionCanceledError());
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", aborted); };

    const settleWithError = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      void worker.terminate();
      reject(error);
    };

    worker.once("message", (message: { wavBuffer?: ArrayBuffer; error?: string }) => {
      if (settled) {
        return;
      }

      if (message.error) {
        settleWithError(new Error(message.error));
        return;
      }

      if (!(message.wavBuffer instanceof ArrayBuffer)) {
        settleWithError(new Error("Worker returned an invalid WAV buffer."));
        return;
      }

      settled = true;
      cleanup();
      void worker.terminate();
      markPerformanceAudit("recording-audio:encode:end", {
        wavBytes: message.wavBuffer.byteLength
      });
      resolve(Buffer.from(message.wavBuffer));
    });

    worker.once("error", (error) => {
      settleWithError(error);
    });

    worker.once("exit", (code) => {
      if (!settled) {
        settleWithError(new Error(`WAV encoder worker exited with code ${code}.`));
      }
    });

    // Cold worker startup can be delayed by host scheduling/disk pressure. Give
    // startup its own bounded budget; encoding keeps the shorter deadline.
    timeout = setTimeout(() => settleWithError(new Error(he.audioConversionFailed)), 45_000);
    worker.once("online", () => {
      if (settled) return;
      clearTimeout(timeout);
      markPerformanceAudit("recording-audio:encoder-online");
      timeout = setTimeout(() => settleWithError(new Error(he.audioConversionFailed)), 15_000);
    });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    worker.postMessage(
      {
        pcmBuffer,
        sampleRate: payload.sampleRate
      },
      [pcmBuffer]
    );
  });
}

async function writeTranscriptMirror(transcript: TranscriptRecord, transcriptsDir: string): Promise<void> {
  await mkdir(transcriptsDir, { recursive: true });
  const safeTimestamp = new Date(transcript.createdAt).toISOString().replace(/[:.]/g, "-");
  const fileName = `${safeTimestamp}-${transcript.id}.txt`;
  await writeFile(join(transcriptsDir, fileName), transcript.text, { encoding: "utf8", mode: 0o600 });
}

export interface TranscriptionWorkflowDependencies {
  database: AppDatabase;
  runtime: AppRuntime;
  settingsService: SettingsService;
  audioConverter: AudioConverterService;
  transcriptionService: TranscriptionService;
  textInsertionService: TextInsertionService;
  showMainWindow: () => void;
  onSettled?: () => void;
  researchArchive?: boolean;
  insertionJournal?: InsertionJournal;
}

/** Asking again cannot help: the app is gone or the field must not receive a paste. */
function isTerminalRefusal(code: string): boolean {
  return code === "target_unavailable" || code === "secure_field";
}

export class TranscriptionWorkflowService {
  /** Main-process-only experiment: overlap durable reservation with final ASR. */
  prepareExperimentalInsertionReservation(): void { this.reserveInsertion(); }
  async abandonExperimentalInsertionReservation(): Promise<void> {
    const id = this.dependencies.runtime.getState().overlaySession?.id;
    if (id && !this.insertionStarted) await this.releaseUnusedReservation(id);
  }
  /** Prepared research ASR can fail before entering transcribeAndStoreInternal. */
  failPreparedRecording(error: unknown): void {
    const canceled = isTranscriptionCanceledError(error);
    const message = canceled ? null : getHebrewErrorMessage(error, he.transcriptionProcessFailed);
    this.dependencies.runtime.clearOverlaySession();
    this.dependencies.textInsertionService.clearTargetApplication();
    this.dependencies.runtime.updateState({
      status: canceled ? "idle" : "error", activeSourceType: null, timerStartedAt: null,
      processingStartedAt: null, processingEstimateMs: null, processingProgressRatio: null,
      lastError: message
    });
    if (message) this.dependencies.runtime.send(IPC_CHANNELS.transcriptionFailed,
      transcriptionErrorPayloadSchema.parse({ message }));
  }
  private preparation: AbortController | null = null;
  private disposed = false;
  private tasks = new Set<Promise<unknown>>();
  private insertionReservations = new Map<string, Promise<boolean>>();
  private canceledBeforeInsertion = false;
  private insertionStarted = false;

  private async releaseUnusedReservation(id: string): Promise<void> {
    if (!this.insertionReservations.has(id)) return;
    try {
      if (await this.insertionReservations.get(id))
        await this.dependencies.insertionJournal?.settle(id, "pending-transcript", "not_dispatched");
    } catch { /* A reserved receipt remains unknown and cannot be retried. */ }
    finally {
      this.dependencies.insertionJournal?.releaseOwnership?.(id);
      this.insertionReservations.delete(id);
    }
  }

  private reserveInsertion(): void {
    const session = this.dependencies.runtime.getState().overlaySession;
    if (!session || !this.dependencies.insertionJournal || this.insertionReservations.has(session.id)) return;
    // Only the current session needs an in-memory promise. Durable claims keep
    // canceled/failed older sessions protected without an ever-growing cache.
    this.insertionReservations.clear();
    pipelineTrace("insertion_reservation", "start");
    const reserved = this.dependencies.insertionJournal.claim(session.id, "pending-transcript")
      .catch(() => false).finally(() => pipelineTrace("insertion_reservation", "end"));
    this.insertionReservations.set(session.id, reserved);
  }

  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new TranscriptionCanceledError());
    const task = action();
    this.tasks.add(task);
    return task.finally(() => this.tasks.delete(task));
  }
  constructor(private readonly dependencies: TranscriptionWorkflowDependencies) {}

  async dispose(): Promise<void> {
    this.disposed = true;
    this.preparation?.abort();
    this.dependencies.transcriptionService.cancel();
    await Promise.allSettled([...this.tasks]);
  }

  transcribeAndStore(input: TranscriptionStartInput): Promise<TranscriptRecord> {
    return this.track(() => this.transcribeAndStoreInternal(input));
  }

  private async transcribeAndStoreInternal(input: TranscriptionStartInput, prepared?: NormalizedTranscriptionResult): Promise<TranscriptRecord> {
    this.canceledBeforeInsertion = false;
    if (input.sourceType === "microphone") this.reserveInsertion();
    const settings = this.dependencies.settingsService.getSettings();
    const processingStartedAt = Date.now();
    const overlaySessionActive =
      input.sourceType === "microphone" && this.dependencies.runtime.getState().overlaySession !== null;
    const insertionSessionId = overlaySessionActive ? this.dependencies.runtime.getState().overlaySession?.id : undefined;
    const processingEstimateMs =
      input.sourceType === "microphone"
        ? estimateMicrophoneProcessingMs({
            durationMs: input.durationMs,
            metalEnabled: settings.metalEnabled,
            speedPreference: settings.speedPreference,
            processingTelemetry: settings.processingTelemetry
          })
        : null;
    let latestAudioDurationMs = input.durationMs ?? null;
    let latestSetupElapsedMs = 0;

    this.dependencies.runtime.updateState({
      status: "processing",
      timerStartedAt: null,
      processingStartedAt,
      processingEstimateMs,
      processingProgressRatio: 0,
      activeSourceType: input.sourceType,
      currentYoutubeJob:
        input.sourceType === "youtube" && input.sourceUrl
          ? {
              url: input.sourceUrl,
              title: input.sourceTitle ?? null
            }
          : null,
      lastError: null
    });
    if (overlaySessionActive) {
      this.dependencies.runtime.updateOverlaySession({
        phase: "processing",
        transcriptId: null,
        transcriptText: null,
        lastErrorCode: null
      });
    }
    this.dependencies.runtime.send(IPC_CHANNELS.transcriptionProgress, { stage: "processing" });

    try {
      const asrStage = prepared ? "prepared_result" : "asr";
      pipelineTrace(asrStage, "start", { prepared: Boolean(prepared) });
      const result = prepared ?? await this.dependencies.transcriptionService.transcribe(input, {
        onProgress: (payload) => {
          if (typeof payload.audioDurationMs === "number" && payload.audioDurationMs > 0) {
            latestAudioDurationMs = payload.audioDurationMs;
          }
          if (typeof payload.setupElapsedMs === "number" && payload.setupElapsedMs > 0) {
            latestSetupElapsedMs = payload.setupElapsedMs;
          }

          if (payload.stage !== "processing") {
            return;
          }

          const currentState = this.dependencies.runtime.getState();
          if (currentState.status !== "processing" || currentState.processingStartedAt !== processingStartedAt) {
            return;
          }

          const nextProgressRatio =
            typeof payload.progressRatio === "number"
              ? Math.max(0, Math.min(1, payload.progressRatio))
              : currentState.processingProgressRatio ?? null;
          const nextEstimateMs =
            currentState.processingEstimateMs == null || nextProgressRatio == null
              ? currentState.processingEstimateMs ?? null
              : refineProcessingEstimateMs({
                  processingStartedAt,
                  processingEstimateMs: currentState.processingEstimateMs,
                  progressRatio: nextProgressRatio
                });

          const shouldUpdateEstimate =
            typeof nextEstimateMs === "number" &&
            (currentState.processingEstimateMs == null ||
              Math.abs(nextEstimateMs - currentState.processingEstimateMs) >= 500);
          const shouldUpdateProgress =
            typeof nextProgressRatio === "number" &&
            nextProgressRatio !== (currentState.processingProgressRatio ?? null);

          if (!shouldUpdateEstimate && !shouldUpdateProgress) {
            return;
          }

          this.dependencies.runtime.updateState({
            processingEstimateMs: shouldUpdateEstimate ? nextEstimateMs : currentState.processingEstimateMs ?? null,
            processingProgressRatio: shouldUpdateProgress ? nextProgressRatio : currentState.processingProgressRatio ?? null
          });
        }
      });
      pipelineTrace(asrStage, "end");
      pipelineTrace("formatting", "start");
      const transcript = this.dependencies.transcriptionService.buildTranscriptRecord(input, result);
      const validated = transcriptRecordSchema.parse(transcript);
      pipelineTrace("formatting", "end");
      if (this.dependencies.researchArchive) {
        pipelineTrace("raw_evidence_write", "start");
        await writeFile(join(this.dependencies.database.paths.userDataPath, `evidence-${transcript.id}.json`),
          JSON.stringify({ input, raw: result, formatted: transcript }), { mode: 0o600 });
        pipelineTrace("raw_evidence_write", "end");
      }
      pipelineTrace("database", "start");
      this.dependencies.database.transcriptRepository.create(transcript);
      pipelineTrace("database", "end");
      let mirrorError: string | null = null;
      try {
        pipelineTrace("text_mirror", "start");
        await writeTranscriptMirror(transcript, this.dependencies.database.paths.transcriptsDir);
      } catch {
        mirrorError = "התמלול נשמר בהיסטוריה, אך עותק ה־TXT לא נשמר. אפשר להעתיק אותו מההיסטוריה.";
        console.warn("[TranscriptionWorkflow] TXT mirror failed; database result retained");
      } finally { pipelineTrace("text_mirror", "end"); }
      // The text now exists and may be pasted. Reporting a failure from here on would
      // offer a retry of work that succeeded, which pastes it a second time.
      pipelineTrace("processing_telemetry", "start");
      try {
        this.recordCompletedProcessingSample({
          settings,
          input,
          processingStartedAt,
          latestAudioDurationMs,
          latestSetupElapsedMs,
          transcript
        });
      } catch { console.warn("[TranscriptionWorkflow] processing telemetry failed; transcript retained"); }
      pipelineTrace("processing_telemetry", "end");
      // Keep the job busy until its single automatic paste has settled.
      await this.maybeCompleteOverlaySession(transcript, input);
      try {
        this.dependencies.runtime.updateState({
          status: "idle", timerStartedAt: null, activeSourceType: null,
          currentYoutubeJob: null, lastError: mirrorError
        });
        this.dependencies.runtime.send(IPC_CHANNELS.transcriptionComplete, { transcript });
        this.maybeNotifyTranscriptCompletion(settings, transcript);
        this.dependencies.runtime.signalTrayReady();
      } catch { console.warn("[TranscriptionWorkflow] completion notice failed; transcript retained"); }

      return validated;
    } catch (error) {
      console.error("[TranscriptionWorkflow] transcription failed", {
        sourceType: input.sourceType,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
      if (isTranscriptionCanceledError(error)) {
        this.dependencies.runtime.updateState({
          status: "idle",
          timerStartedAt: null,
          activeSourceType: null,
          currentYoutubeJob: null,
          lastError: null
        });
        if (overlaySessionActive) {
          this.dependencies.runtime.clearOverlaySession();
          this.dependencies.textInsertionService.clearTargetApplication();
        }
        throw error;
      }

      const message = getHebrewErrorMessage(error, he.transcriptionProcessFailed);
      const shouldContinueWithQueuedYoutube = Boolean(this.dependencies.runtime.getState().pendingYoutubeJob);
      this.dependencies.runtime.updateState({
        status: shouldContinueWithQueuedYoutube ? "idle" : "error",
        timerStartedAt: null,
        activeSourceType: null,
        currentYoutubeJob: null,
        lastError: shouldContinueWithQueuedYoutube ? null : message
      });
      this.dependencies.runtime.send(
        IPC_CHANNELS.transcriptionFailed,
        transcriptionErrorPayloadSchema.parse({ message })
      );
      if (overlaySessionActive) {
        this.dependencies.runtime.clearOverlaySession();
        this.dependencies.textInsertionService.clearTargetApplication();
      }
      throw error;
    } finally {
      // ASR failure/cancellation can finish before the insertion method is ever
      // reached. Release in-memory ownership while retaining the durable claim.
      if (insertionSessionId) await this.releaseUnusedReservation(insertionSessionId);
    }
  }

  async transcribeStandalone(input: TranscriptionStartInput): Promise<TranscriptRecord> {
    try {
      return await this.transcribeAndStore(input);
    } finally {
      this.dependencies.onSettled?.();
    }
  }

  transcribeRecordingAudio(payload: RecordingAudioPayload): Promise<TranscriptRecord> {
    return this.track(() => this.transcribeRecordingAudioInternal(payload));
  }

  /** Internal research entrypoint. Renderer IPC cannot supply a transcript. */
  transcribePreparedRecording(input: TranscriptionStartInput, result: NormalizedTranscriptionResult): Promise<TranscriptRecord> {
    return this.track(async () => {
      try { return await this.transcribeAndStoreInternal(input, result); }
      finally { this.dependencies.onSettled?.(); }
    });
  }

  private async transcribeRecordingAudioInternal(payload: RecordingAudioPayload): Promise<TranscriptRecord> {
    beginPipelineTrace();
    this.reserveInsertion();
    const wavPath = join(this.dependencies.database.paths.userDataPath, `recording-${Date.now()}.wav`);
    const preparation = new AbortController();
    this.preparation = preparation;
    try {
      markPerformanceAudit("recording-audio:write-wav:start");
      if (this.dependencies.researchArchive) {
        pipelineTrace("source_archive", "start");
        const pcm = normalizeRecordingPcm(payload.pcm);
        await writeFile(wavPath + ".f32le", Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), { mode: 0o600 });
        await writeFile(wavPath + ".capture.json", JSON.stringify({ sampleRate: payload.sampleRate, durationMs: payload.durationMs, samples: pcm.length }), { mode: 0o600 });
        pipelineTrace("source_archive", "end");
      }
      pipelineTrace("wav_encoding", "start");
      const wav = await encodeWavFromRecordingPayload(payload, preparation.signal);
      pipelineTrace("wav_encoding", "end");
      pipelineTrace("wav_write", "start");
      await writeFile(wavPath, wav, { mode: 0o600, signal: preparation.signal });
      pipelineTrace("wav_write", "end");
      if (preparation.signal.aborted) throw new TranscriptionCanceledError();
      this.preparation = null;
      markPerformanceAudit("recording-audio:write-wav:end");
      return await this.transcribeAndStore({
        wavPath,
        sourceType: "microphone",
        durationMs: Math.round(payload.durationMs),
        importedFileName: null
      });
    } catch (error) {
      if (this.preparation === preparation) {
        const canceled = preparation.signal.aborted || isTranscriptionCanceledError(error);
        this.dependencies.runtime.clearOverlaySession();
        this.dependencies.textInsertionService.clearTargetApplication();
        this.dependencies.runtime.updateState({ status: canceled ? "idle" : "error", timerStartedAt: null,
          activeSourceType: null, lastError: canceled ? null : he.audioConversionFailed });
        if (canceled) throw new TranscriptionCanceledError();
      }
      throw error;
    } finally {
      if (this.preparation === preparation) this.preparation = null;
      if (!this.dependencies.researchArchive) await rm(wavPath, { force: true }).catch(() => undefined);
      this.dependencies.onSettled?.();
    }
  }

  transcribeImportedFile(filePath: string): Promise<{ canceled: false; fileName: string; transcript: TranscriptRecord }> {
    return this.track(() => this.transcribeImportedFileInternal(filePath));
  }

  private async transcribeImportedFileInternal(filePath: string): Promise<{ canceled: false; fileName: string; transcript: TranscriptRecord }> {
    const state = this.dependencies.runtime.getState();
    if (state.status !== "idle" && state.status !== "error") throw new Error("כבר יש הקלטה או עיבוד פעילים.");
    const wavPath = join(this.dependencies.database.paths.userDataPath, `import-${crypto.randomUUID()}.wav`);
    const preparation = new AbortController();
    this.preparation = preparation;
    this.dependencies.runtime.updateState({ status: "processing", activeSourceType: "imported_file", timerStartedAt: null, lastError: null });
    try {
      await this.dependencies.audioConverter.convertInputToWav(filePath, wavPath, preparation.signal);
      if (preparation.signal.aborted) throw new TranscriptionCanceledError();
      this.preparation = null;
      const transcript = await this.transcribeAndStore({
        wavPath,
        sourceType: "imported_file",
        importedFileName: basename(filePath)
      });

      return {
        canceled: false,
        fileName: basename(filePath),
        transcript
      };
    } catch (error) {
      if (this.preparation === preparation) {
        const canceled = preparation.signal.aborted || isTranscriptionCanceledError(error);
        this.dependencies.runtime.updateState({ status: canceled ? "idle" : "error", activeSourceType: null,
          lastError: canceled ? null : he.audioConversionFailed });
        if (canceled) throw new TranscriptionCanceledError();
      }
      throw error;
    } finally {
      if (this.preparation === preparation) this.preparation = null;
      await rm(wavPath, { force: true }).catch(() => undefined);
      this.dependencies.onSettled?.();
    }
  }

  async waitForSettled(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }

  /** The user asked again from the HUD, which is what permits bringing the target back to the front. */
  async retryPaste(text: string): Promise<boolean> {
    try {
      const inserted = await this.dependencies.textInsertionService.insertIntoCapturedTarget(text, undefined, { explicit: true });
      this.dependencies.runtime.updateOverlaySession({ phase: "success", lastErrorCode: null, insertionOutcome: this.deliveredOutcome() });
      return inserted;
    } catch (error) {
      const unknown = this.dependencies.textInsertionService.hasUnknownNativeOutcome?.() ?? false;
      const code = error instanceof TextInsertionError ? error.code : "paste_failed";
      this.dependencies.runtime.updateOverlaySession({
        lastErrorCode: code,
        ...(unknown ? { manualCopyOnly: true, insertionOutcome: "unknown" as const }
          : isTerminalRefusal(code) ? { manualCopyOnly: true, insertionOutcome: "not_dispatched" as const } : {})
      });
      throw error;
    }
  }

  private deliveredOutcome(): "confirmed" | "unverified" {
    const outcome = this.dependencies.textInsertionService.getLastInsertionOutcome?.();
    return outcome === "dispatched_unverified" || outcome === "command_completed_unverified" ? "unverified" : "confirmed";
  }

  cancelActiveTranscription(): boolean {
    if (this.preparation) {
      this.preparation.abort();
      return true;
    }
    // The job's catch/finally owns the state transition. A new recording must not
    // start while the canceled worker is still settling its previous request.
    const canceled = this.dependencies.transcriptionService.cancel();
    const state = this.dependencies.runtime.getState();
    if (!canceled && state.status === "processing" && state.activeSourceType === "microphone") {
      if (this.insertionStarted) {
        if (this.dependencies.insertionJournal) this.dependencies.textInsertionService.cancelPendingResearchInsertion?.();
        return false; // Delivery may have committed: preserve the recovery warning.
      }
      this.canceledBeforeInsertion = true;
      return true;
    }
    return canceled;
  }

  private async maybeCompleteOverlaySession(transcript: TranscriptRecord, input: TranscriptionStartInput): Promise<void> {
    const overlaySession = this.dependencies.runtime.getState().overlaySession;
    if (!overlaySession || transcript.sourceType !== "microphone") {
      return;
    }

    if (!this.dependencies.insertionJournal && this.dependencies.textInsertionService.isOwnWindowTarget?.()) {
      this.dependencies.textInsertionService.clearTargetApplication();
      this.dependencies.runtime.updateOverlaySession({
        phase: "success", deliveredInApp: true,
        transcriptId: transcript.id, transcriptText: transcript.text, lastErrorCode: null
      });
      return;
    }

    let claimed = false;
    try {
      if (this.dependencies.insertionJournal) {
        pipelineTrace("reservation_wait", "start");
        claimed = Boolean(await this.insertionReservations.get(overlaySession.id));
        pipelineTrace("reservation_wait", "end");
        if (!claimed) throw new TextInsertionError("paste_failed", "Automatic insertion already reserved; inspect the target before manual recovery.");
        // Recovery must be durable before any external mutation can start. A
        // crash after dispatch leaves the reserved outcome explicitly unknown.
        pipelineTrace("recovery_receipt", "start");
        await this.dependencies.insertionJournal.attachRecovery(overlaySession.id, transcript.id, {
          transcriptText: transcript.text,
          audioPath: input.wavPath,
          evidencePath: join(this.dependencies.database.paths.userDataPath, `evidence-${transcript.id}.json`),
          target: this.dependencies.textInsertionService.getRecoveryTargetMetadata?.() ?? null
        });
        pipelineTrace("recovery_receipt", "end");
      }
      if (this.canceledBeforeInsertion) throw new TextInsertionError("paste_failed", "Canceled before dispatch; saved transcript retained.");
      pipelineTrace("insertion", "start");
      this.insertionStarted = true;
      const inserted = this.dependencies.insertionJournal
        ? await this.dependencies.textInsertionService.insertIntoCapturedTarget(transcript.text, transcript.id)
        : await this.dependencies.textInsertionService.insertIntoCapturedTarget(transcript.text);
      if (this.dependencies.insertionJournal && !inserted) throw new TextInsertionError("paste_failed", "No insertion was dispatched; saved source retained.");
      await this.dependencies.insertionJournal?.settle(overlaySession.id, transcript.id,
        this.dependencies.textInsertionService.getLastInsertionOutcome?.() ?? "command_completed_unverified");
      if (this.dependencies.insertionJournal && this.dependencies.textInsertionService.getLastInsertionOutcome?.() !== "confirmed")
        throw new TextInsertionError("paste_failed", "Insertion command completed without observable acknowledgement; inspect the target.");
      pipelineTrace("insertion", "end", { success: true });
      this.dependencies.runtime.updateOverlaySession({
        phase: "success",
        insertionOutcome: this.deliveredOutcome(),
        transcriptId: transcript.id,
        transcriptText: transcript.text,
        lastErrorCode: null
      });
    } catch (error) {
      const outcome = this.canceledBeforeInsertion || !this.insertionStarted ? "not_dispatched"
        : this.dependencies.textInsertionService.getLastInsertionOutcome?.() ?? "outcome_uncertain";
      if (claimed) await this.dependencies.insertionJournal?.settle(overlaySession.id, transcript.id,
        outcome).catch(() => undefined);
      pipelineTrace("insertion", "end", { success: false });
      const fallbackCode = "paste_failed";
      const errorCode = error instanceof TextInsertionError ? error.code : fallbackCode;
      const unknownNativeOutcome = this.dependencies.textInsertionService.hasUnknownNativeOutcome?.() ?? false;
      this.dependencies.runtime.updateOverlaySession({
        phase: "paste_failed",
        ...(this.dependencies.insertionJournal || this.canceledBeforeInsertion || unknownNativeOutcome || isTerminalRefusal(errorCode) ? { manualCopyOnly: true, insertionOutcome: outcome === "not_dispatched" ? "not_dispatched" as const : "unknown" as const } : {}),
        transcriptId: transcript.id,
        transcriptText: transcript.text,
        lastErrorCode: errorCode
      });
    } finally {
      this.insertionStarted = false;
      this.dependencies.insertionJournal?.releaseOwnership?.(overlaySession.id);
      this.insertionReservations.delete(overlaySession.id);
    }
  }

  /** A call has no overlay, paste or runtime status of its own, so only the storing steps apply. */
  async saveCallTranscript(input: TranscriptionStartInput, result: NormalizedTranscriptionResult): Promise<void> {
    const transcript = this.dependencies.transcriptionService.buildTranscriptRecord(input, result);
    transcriptRecordSchema.parse(transcript);
    this.dependencies.database.transcriptRepository.create(transcript);
    await writeTranscriptMirror(transcript, this.dependencies.database.paths.transcriptsDir)
      .catch(() => console.warn("[TranscriptionWorkflow] TXT mirror failed; database result retained"));
    this.dependencies.runtime.send(IPC_CHANNELS.transcriptionComplete, { transcript });
    this.maybeNotifyTranscriptCompletion(this.dependencies.settingsService.getSettings(), transcript);
    this.dependencies.runtime.signalTrayReady();
  }

  private maybeNotifyTranscriptCompletion(settings: AppSettings, transcript: TranscriptRecord): void {
    if (
      !Notification.isSupported() ||
      !shouldNotifyTranscriptCompletion({
        settings,
        transcript,
        appFocused: BrowserWindow.getFocusedWindow() !== null
      })
    ) {
      return;
    }

    const notification = new Notification(buildTranscriptCompletionNotification(transcript));
    notification.on("click", () => {
      this.dependencies.showMainWindow();
      this.dependencies.runtime.requestMainNavigation("workspace");
    });
    notification.show();
  }

  private recordCompletedProcessingSample({
    settings,
    input,
    processingStartedAt,
    latestAudioDurationMs,
    latestSetupElapsedMs,
    transcript
  }: {
    settings: AppSettings;
    input: TranscriptionStartInput;
    processingStartedAt: number;
    latestAudioDurationMs: number | null;
    latestSetupElapsedMs: number;
    transcript: TranscriptRecord;
  }): void {
    if (input.sourceType === "call") return;
    const durationMs =
      input.durationMs ??
      latestAudioDurationMs ??
      this.inferDurationMsFromSegments(transcript.segments) ??
      null;

    if (!durationMs || durationMs <= 0) {
      return;
    }

    const totalElapsedMs = Math.max(1_000, Date.now() - processingStartedAt);
    const nextTelemetry = recordProcessingTimingSample(settings.processingTelemetry, {
      sourceType: input.sourceType,
      speedPreference: settings.speedPreference,
      durationMs,
      setupMs: latestSetupElapsedMs,
      totalElapsedMs
    });

    this.dependencies.settingsService.setSetting("processingTelemetry", nextTelemetry);
  }

  private inferDurationMsFromSegments(segments: TranscriptSegment[] | null | undefined): number | null {
    if (!segments || segments.length === 0) {
      return null;
    }

    const lastSegment = segments[segments.length - 1];
    if (!lastSegment || typeof lastSegment.end !== "number" || lastSegment.end <= 0) {
      return null;
    }

    return Math.round(lastSegment.end * 1000);
  }
}
