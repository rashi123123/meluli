import { copyFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getHebrewErrorMessage } from "@shared/error-utils";
import {
  estimateMicrophoneProcessingMs,
  telemetryAfterJob,
  refineProcessingEstimateMs
} from "@shared/processing-estimate";
import { transcriptRecordSchema, transcriptionErrorPayloadSchema } from "@shared/schemas";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { he } from "@shared/locale";
import type {
  AppSettings,
  RecordingAudioPayload,
  TranscriptRecord,
  TranscriptionStartInput,
  MainView
} from "@shared/types";
import type { AppDatabase } from "../db/database";
import { markPerformanceAudit } from "../diagnostics/perf-audit";
import { AudioConverterService } from "./audio-converter.service";
import { SettingsService } from "./settings.service";
import { formatForTarget } from "./insertion/target-format";
import { notifyTranscriptCompletion } from "./transcript-notification.service";
import {
  TranscriptionService
} from "./transcription.service";
import type { NormalizedTranscriptionResult } from "./transcription-protocol";
import { isTranscriptionCanceledError, TranscriptionCanceledError } from "./transcription-errors";
import { buildTranscriptRecord } from "./transcript-record";
import { temporaryAudioPath } from "./orphan-audio";
import { AppRuntime, assertNothingRunning, isFree } from "../runtime";
import { TextInsertionError, TextInsertionService } from "./insertion/text-insertion.service";
import type { FlowService } from "./flows/flow.service";
import { OverlayFlows, type FlowPreviewChoice } from "./flows/overlay-flows";
import { encodeWavFromRecordingPayload, normalizeRecordingPcm } from "./recording-wav";
import { writeTranscriptMirror } from "./transcript-files";
import { beginPipelineTrace, pipelineTrace } from "../diagnostics/pipeline-trace";
import type { InsertionJournal } from "./insertion/insertion-journal";
import type { RecordingAudioStore } from "./recording-audio-store";

export interface TranscriptionWorkflowDependencies {
  database: AppDatabase;
  runtime: AppRuntime;
  settingsService: SettingsService;
  audioConverter: AudioConverterService;
  transcriptionService: TranscriptionService;
  textInsertionService: TextInsertionService;
  showMainWindow: (view?: MainView) => void;
  onSettled?: () => void;
  researchArchive?: boolean;
  insertionJournal?: InsertionJournal;
  /** Microphone audio kept for transcribing again. Absent in research runs, which archive their own. */
  recordings?: RecordingAudioStore;
  flows?: Pick<FlowService, "run">;
}

interface StoreOptions {
  /** A recording transcribed again from History is never pasted and never opens the floating recorder. */
  paste?: boolean;
  /** The transcript this recording already produced, replaced in place. */
  replaceId?: string;
  /** A kept recording transcribed again is never pasted, so a letter the model splits is repaired, not refused. */
  repairText?: boolean;
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
    this.endOverlaySession();
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
  /** The flow chosen for the dictation, its preview and its revert. */
  private readonly overlayFlows: OverlayFlows;
  constructor(private readonly dependencies: TranscriptionWorkflowDependencies) {
    this.overlayFlows = new OverlayFlows({ ...dependencies, shapeForTarget: (text) => this.shapeForTarget(text) });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.preparation?.abort();
    this.overlayFlows.abort();
    this.overlayFlows.declinePreview();
    this.dependencies.transcriptionService.cancel();
    await Promise.allSettled([...this.tasks]);
  }

  transcribeAndStore(input: TranscriptionStartInput): Promise<TranscriptRecord> {
    return this.track(() => this.transcribeAndStoreInternal(input));
  }

  private async transcribeAndStoreInternal(input: TranscriptionStartInput, prepared?: NormalizedTranscriptionResult, options: StoreOptions = {}): Promise<TranscriptRecord> {
    const paste = options.paste !== false;
    this.canceledBeforeInsertion = false;
    if (paste && input.sourceType === "microphone") this.reserveInsertion();
    const settings = this.dependencies.settingsService.getSettings();
    const processingStartedAt = Date.now();
    const overlaySessionActive =
      paste && input.sourceType === "microphone" && this.dependencies.runtime.getState().overlaySession !== null;
    const insertionSessionId = overlaySessionActive ? this.dependencies.runtime.getState().overlaySession?.id : undefined;
    const processingEstimateMs =
      input.sourceType === "microphone"
        ? estimateMicrophoneProcessingMs({
            durationMs: input.durationMs,
            speedPreference: settings.speedPreference,
            processingTelemetry: settings.processingTelemetry
          })
        : null;
    let latestAudioDurationMs = input.durationMs ?? null;
    let latestSetupElapsedMs = 0;

    this.dependencies.runtime.updateJobState({
      status: "processing",
      timerStartedAt: null,
      processingStartedAt,
      processingEstimateMs,
      processingProgressRatio: 0,
      // The floating recorder follows a microphone job, so a job from History reads as an import.
      activeSourceType: paste ? input.sourceType : "imported_file",
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

    try {
      const asrStage = prepared ? "prepared_result" : "asr";
      pipelineTrace(asrStage, "start", { prepared: Boolean(prepared) });
      const result = prepared ?? await this.dependencies.transcriptionService.transcribe(input, {
        ...(options.repairText && !paste ? { repairText: true } : {}),
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
      const built = buildTranscriptRecord(this.dependencies.settingsService.getSettings(), input, result);
      transcriptRecordSchema.parse(built);
      pipelineTrace("formatting", "end");
      if (this.dependencies.researchArchive) {
        pipelineTrace("raw_evidence_write", "start");
        await writeFile(join(this.dependencies.database.paths.userDataPath, `evidence-${built.id}.json`),
          JSON.stringify({ input, raw: result, formatted: built }), { mode: 0o600 });
        pipelineTrace("raw_evidence_write", "end");
      }
      pipelineTrace("database", "start");
      const repository = this.dependencies.database.transcriptRepository;
      let transcript = built;
      if (options.replaceId) {
        const replaced = repository.replaceTranscription(options.replaceId, built);
        if (!replaced) throw new Error(he.recordingTranscriptGone);
        transcript = replaced;
      } else repository.create(built);
      const validated = transcriptRecordSchema.parse(transcript);
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
        const telemetry = telemetryAfterJob(settings, input, {
          processingStartedAt,
          workerAudioMs: latestAudioDurationMs,
          setupMs: latestSetupElapsedMs,
          segments: transcript.segments
        });
        if (telemetry) this.dependencies.settingsService.setSetting("processingTelemetry", telemetry);
      } catch { console.warn("[TranscriptionWorkflow] processing telemetry failed; transcript retained"); }
      pipelineTrace("processing_telemetry", "end");
      // Keep the job busy until its single automatic paste has settled.
      if (paste) await this.maybeCompleteOverlaySession(transcript, input);
      try {
        this.dependencies.runtime.updateJobState({
          status: "idle", timerStartedAt: null, activeSourceType: null,
          currentYoutubeJob: null, lastError: mirrorError
        });
        // A replaced row keeps its place in History; the caller hands it to the screen itself.
        this.announceTranscript(settings, transcript, !options.replaceId);
      } catch { console.warn("[TranscriptionWorkflow] completion notice failed; transcript retained"); }

      return validated;
    } catch (error) {
      console.error("[TranscriptionWorkflow] transcription failed", {
        sourceType: input.sourceType,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
      if (isTranscriptionCanceledError(error)) {
        this.dependencies.runtime.updateJobState({
          status: "idle",
          timerStartedAt: null,
          activeSourceType: null,
          currentYoutubeJob: null,
          lastError: null
        });
        if (overlaySessionActive) {
          this.endOverlaySession();
        }
        throw error;
      }

      const message = getHebrewErrorMessage(error, he.transcriptionProcessFailed);
      const shouldContinueWithQueuedYoutube = Boolean(this.dependencies.runtime.getState().pendingYoutubeJob);
      this.dependencies.runtime.updateJobState({
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
        this.endOverlaySession();
      }
      throw error;
    } finally {
      // ASR failure/cancellation can finish before the insertion method is ever
      // reached. Release in-memory ownership while retaining the durable claim.
      if (insertionSessionId) await this.releaseUnusedReservation(insertionSessionId);
    }
  }

  /**
   * A finished recording. `prepared` is the streaming engine's text for exactly this audio; it is
   * stored and pasted as is, and the audio is encoded afterwards only when the recording is kept.
   */
  transcribeRecordingAudio(payload: RecordingAudioPayload, prepared?: NormalizedTranscriptionResult): Promise<TranscriptRecord> {
    return this.track(() => prepared
      ? this.storePreparedRecordingAudio(payload, prepared)
      : this.transcribeRecordingAudioInternal(payload));
  }

  private async storePreparedRecordingAudio(payload: RecordingAudioPayload, prepared: NormalizedTranscriptionResult): Promise<TranscriptRecord> {
    this.reserveInsertion();
    const wavPath = temporaryAudioPath(this.dependencies.database.paths.userDataPath, "recording");
    const recordingId = this.dependencies.researchArchive ? undefined : payload.recordingId;
    const keepWav = async () => {
      await writeFile(wavPath, await encodeWavFromRecordingPayload(payload, new AbortController().signal), { mode: 0o600 });
      return wavPath;
    };
    try {
      const transcript = await this.track(() => this.transcribeAndStoreInternal({
        wavPath, sourceType: "microphone", durationMs: Math.round(payload.durationMs), importedFileName: null
      }, prepared));
      if (recordingId) {
        const kept = this.dependencies.settingsService.getSettings().keepRecordingAudio ? await keepWav().catch(() => null) : null;
        await this.settleRecordingAudio(recordingId, kept, payload, { transcriptId: transcript.id });
      }
      return transcript;
    } catch (error) {
      if (recordingId) {
        const canceled = !this.disposed && isTranscriptionCanceledError(error);
        // The words never reached History, so the audio is what the person can try again from.
        await this.settleRecordingAudio(recordingId, canceled ? null : await keepWav().catch(() => null), payload, canceled ? "canceled" : "failed");
      }
      throw error;
    } finally {
      await rm(wavPath, { force: true }).catch(() => undefined);
      this.dependencies.onSettled?.();
    }
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
    const wavPath = temporaryAudioPath(this.dependencies.database.paths.userDataPath, "recording");
    const recordingId = this.dependencies.researchArchive ? undefined : payload.recordingId;
    let wavWritten = false;
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
      wavWritten = true;
      pipelineTrace("wav_write", "end");
      if (preparation.signal.aborted) throw new TranscriptionCanceledError();
      this.preparation = null;
      markPerformanceAudit("recording-audio:write-wav:end");
      const transcript = await this.transcribeAndStore({
        wavPath,
        sourceType: "microphone",
        durationMs: Math.round(payload.durationMs),
        importedFileName: null
      });
      if (recordingId) await this.settleRecordingAudio(recordingId, wavPath, payload, { transcriptId: transcript.id });
      return transcript;
    } catch (error) {
      if (recordingId) {
        // Quitting cancels the job too, but nobody asked to throw this recording away.
        const canceled = !this.disposed && (preparation.signal.aborted || isTranscriptionCanceledError(error));
        await this.settleRecordingAudio(recordingId, wavWritten ? wavPath : null, payload, canceled ? "canceled" : "failed");
      }
      if (this.preparation === preparation) {
        const canceled = preparation.signal.aborted || isTranscriptionCanceledError(error);
        this.endOverlaySession();
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

  /**
   * Keeps this recording's audio on disk, or lets it go. A failure here never fails the
   * dictation: the text is already stored and may already be pasted.
   */
  private async settleRecordingAudio(
    id: string,
    wavPath: string | null,
    payload: RecordingAudioPayload,
    outcome: { transcriptId: string } | "failed" | "canceled"
  ): Promise<void> {
    const store = this.dependencies.recordings;
    if (!store) return;
    try {
      // What was written while it lasted goes; a failed recording retried and canceled again stays.
      if (outcome === "canceled") { await store.discardSpool(id); return; }
      if (outcome !== "failed" && !this.dependencies.settingsService.getSettings().keepRecordingAudio) {
        await store.remove(id);
        return;
      }
      if (!wavPath) { await store.keepSpool(id); return; }
      await store.keep(id, wavPath, {
        status: outcome === "failed" ? "failed" : "kept",
        transcriptId: outcome === "failed" ? null : outcome.transcriptId,
        durationMs: payload.durationMs,
        sampleRate: payload.sampleRate
      });
    } catch {
      console.warn("[TranscriptionWorkflow] recording audio was not kept");
    }
  }

  /**
   * Transcribes a kept recording again from History. A recording whose transcript still
   * exists replaces that transcript in place; one that failed becomes a new transcript.
   */
  transcribeStoredRecording(id: string): Promise<{ transcript: TranscriptRecord; replaced: boolean }> {
    return this.track(async () => {
      const { recordings: store, runtime, database } = this.dependencies;
      assertNothingRunning(runtime);
      const recording = await store?.get(id);
      if (!store || !recording) throw new Error(he.recordingAudioMissing);
      const replaceId = recording.transcriptId && database.transcriptRepository.getById(recording.transcriptId)
        ? recording.transcriptId : undefined;
      // A copy, so deleting the recording meanwhile cannot pull the file from under the model.
      const wavPath = temporaryAudioPath(database.paths.userDataPath, "recording");
      try {
        await copyFile(store.audioPath(id), wavPath);
        const transcript = await this.transcribeAndStoreInternal(
          { wavPath, sourceType: "microphone", durationMs: recording.durationMs, importedFileName: null },
          undefined,
          { paste: false, replaceId, repairText: true }
        );
        if (!replaceId) {
          await store.attachTranscript(id, transcript.id, this.dependencies.settingsService.getSettings().keepRecordingAudio)
            .catch(() => console.warn("[TranscriptionWorkflow] recording was not attached to its transcript"));
        }
        return { transcript, replaced: Boolean(replaceId) };
      } finally {
        await rm(wavPath, { force: true }).catch(() => undefined);
        this.dependencies.onSettled?.();
      }
    });
  }

  transcribeImportedFile(filePath: string): Promise<{ canceled: false; fileName: string; transcript: TranscriptRecord }> {
    return this.track(() => this.transcribeImportedFileInternal(filePath));
  }

  private async transcribeImportedFileInternal(filePath: string): Promise<{ canceled: false; fileName: string; transcript: TranscriptRecord }> {
    assertNothingRunning(this.dependencies.runtime);
    const wavPath = temporaryAudioPath(this.dependencies.database.paths.userDataPath, "import");
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

  /** Only the pasted copy changes. The transcript and the recovery receipt keep the full text. */
  private shapeForTarget(text: string): string {
    if (!this.dependencies.settingsService.getSettings().formatForApp) return text;
    return formatForTarget(text, this.dependencies.textInsertionService.getCapturedTargetBundleId?.() ?? null);
  }

  /** The user asked again from the HUD, which is what permits bringing the target back to the front. */
  async retryPaste(text: string): Promise<boolean> {
    const { runtime } = this.dependencies;
    if (runtime.isPasteRetrying()) throw new TextInsertionError("paste_failed", he.textInsertionFailed);
    const sessionId = runtime.getState().overlaySession?.id;
    // The result describes this session's text, so a later session must not inherit it.
    const stillCurrent = () => runtime.getState().overlaySession?.id === sessionId;
    runtime.setPasteRetrying(true);
    try {
      const inserted = await this.dependencies.textInsertionService.insertIntoCapturedTarget(this.shapeForTarget(text), undefined, { explicit: true });
      if (stillCurrent()) runtime.updateOverlaySession({ phase: "success", lastErrorCode: null, insertionOutcome: this.deliveredOutcome() });
      return inserted;
    } catch (error) {
      const unknown = this.dependencies.textInsertionService.hasUnknownNativeOutcome?.() ?? false;
      const code = error instanceof TextInsertionError ? error.code : "paste_failed";
      if (stillCurrent()) runtime.updateOverlaySession({
        lastErrorCode: code,
        ...(unknown ? { manualCopyOnly: true, insertionOutcome: "unknown" as const }
          : isTerminalRefusal(code) ? { manualCopyOnly: true, insertionOutcome: "not_dispatched" as const } : {})
      });
      throw error;
    } finally {
      runtime.setPasteRetrying(false);
    }
  }

  private deliveredOutcome(): "confirmed" | "unverified" {
    const outcome = this.dependencies.textInsertionService.getLastInsertionOutcome?.();
    return outcome === "dispatched_unverified" || outcome === "command_completed_unverified" ? "unverified" : "confirmed";
  }

  cancelActiveTranscription(): boolean {
    // Esc on a flow preview pastes the dictation as spoken, so nothing is canceled.
    if (this.overlayFlows.declinePreview()) return false;
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
      this.overlayFlows.abort();
      return true;
    }
    return canceled;
  }

  routeOverlayFlow(): void { this.overlayFlows.route(); }
  chooseOverlayFlow(flowId: string | null): boolean { return this.overlayFlows.choose(flowId); }
  chooseFlowPreview(choice: FlowPreviewChoice): Promise<void> | null { return this.overlayFlows.choosePreview(choice); }
  isFlowPreviewPending(): boolean { return this.overlayFlows.isPreviewPending(); }
  revertFlow(): Promise<void> { return this.overlayFlows.revert(); }

  /** The builder's test: a dictation transcribed like any other, but never stored or pasted. */
  async transcribeForFlowTest(payload: RecordingAudioPayload): Promise<string> {
    const state = this.dependencies.runtime.getState();
    if (!isFree(state.status)) throw new Error("יש הקלטה או תמלול פעילים. נסו שוב בעוד רגע.");
    const wavPath = temporaryAudioPath(this.dependencies.database.paths.userDataPath, "flow-test");
    try {
      await writeFile(wavPath, await encodeWavFromRecordingPayload(payload, new AbortController().signal), { mode: 0o600 });
      const input = { wavPath, sourceType: "microphone" as const, durationMs: Math.round(payload.durationMs) };
      const result = await this.dependencies.transcriptionService.transcribe(input);
      return buildTranscriptRecord(this.dependencies.settingsService.getSettings(), input, result).text;
    } finally {
      await rm(wavPath, { force: true }).catch(() => undefined);
    }
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
    let delivered = transcript.text;
    let pasteSettled!: () => void;
    const pasteDone = new Promise<void>((resolve) => { pasteSettled = resolve; });
    try {
      delivered = await this.overlayFlows.apply(transcript, overlaySession, pasteDone);
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
        ? await this.dependencies.textInsertionService.insertIntoCapturedTarget(this.shapeForTarget(delivered), transcript.id)
        : await this.dependencies.textInsertionService.insertIntoCapturedTarget(this.shapeForTarget(delivered));
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
        transcriptText: delivered,
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
        transcriptText: delivered,
        lastErrorCode: errorCode
      });
    } finally {
      pasteSettled();
      this.insertionStarted = false;
      this.dependencies.insertionJournal?.releaseOwnership?.(overlaySession.id);
      this.insertionReservations.delete(overlaySession.id);
    }
  }

  /** A call has no overlay, paste or runtime status of its own, so only the storing steps apply. */
  /** The call's id keys the row, so a retry after this save cannot store the same call twice. */
  async saveCallTranscript(callId: string, input: TranscriptionStartInput, result: NormalizedTranscriptionResult): Promise<void> {
    if (this.dependencies.database.transcriptRepository.getById(callId)) return;
    const transcript = { ...buildTranscriptRecord(this.dependencies.settingsService.getSettings(), input, result), id: callId };
    transcriptRecordSchema.parse(transcript);
    this.dependencies.database.transcriptRepository.create(transcript);
    await writeTranscriptMirror(transcript, this.dependencies.database.paths.transcriptsDir)
      .catch(() => console.warn("[TranscriptionWorkflow] TXT mirror failed; database result retained"));
    this.announceTranscript(this.dependencies.settingsService.getSettings(), transcript, true);
  }

  /** A stored transcript reaches History, the completion notice and the tray, in that order. */
  private announceTranscript(settings: AppSettings, transcript: TranscriptRecord, toHistory: boolean): void {
    if (toHistory) this.dependencies.runtime.send(IPC_CHANNELS.transcriptionComplete, { transcript });
    this.maybeNotifyTranscriptCompletion(settings, transcript);
    this.dependencies.runtime.signalTrayReady();
  }

  /** The overlay and the app it would paste into end together, so a later paste has no target. */
  private endOverlaySession(): void {
    this.dependencies.runtime.clearOverlaySession();
    this.dependencies.textInsertionService.clearTargetApplication();
  }

  private maybeNotifyTranscriptCompletion(settings: AppSettings, transcript: TranscriptRecord): void {
    notifyTranscriptCompletion(settings, transcript, () => this.dependencies.showMainWindow("workspace"));
  }
}
