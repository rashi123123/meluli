import { join } from "node:path";
import type { WebContents } from "electron";
import { dictationChunkSchema } from "@shared/experimental-dictation";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { RecordingAudioPayload, TranscriptRecord } from "@shared/types";
import { beginPipelineTrace, pipelineTrace } from "../diagnostics/pipeline-trace";
import type { AppServiceContainer } from "../services/container";
import { ExperimentalDictationService, experimentalDictationRoot } from "../services/experimental-dictation.service";
import { LiveDictationService } from "../services/live-dictation.service";
import { TranscriptionCanceledError } from "../services/transcription-errors";
import { normalizeRecordingPcm } from "../services/recording-wav";
import type { IpcRegistry } from "./registry";

type ExperimentDependencies = Pick<AppServiceContainer,
  "database" | "runtime" | "getTranscriptionService" | "getTranscriptionWorkflow"> & { isPackaged: boolean };

/**
 * The experimental streaming dictation session (dev builds, or MELULI_DICTATION_ROOT).
 * It owns the session state that the recording and cancel handlers in register.ts consult:
 * whether a session is running, its id, and which renderer started it. With no root the
 * service is absent and every method here is a no-op, as before.
 */
export class ExperimentalDictationIpc {
  private readonly root: string | null;
  private readonly experiment: ExperimentalDictationService | null;
  private active = false;
  private sessionId: string | null = null;
  private ownerId: number | null = null;
  private readonly observedSenders = new WeakSet<WebContents>();
  /** Live dictation on a streaming engine (absent for research runs; each dictation checks the engine). */
  private readonly live: LiveDictationService | null;
  /** A live stop waiting for the session's text; a cancel meanwhile ends it before the workflow. */
  private liveStop: { canceled: boolean } | null = null;

  constructor(private readonly dependencies: ExperimentDependencies) {
    this.root = experimentalDictationRoot(dependencies.isPackaged, dependencies.database.paths.userDataPath);
    this.experiment = this.root ? new ExperimentalDictationService(
      this.root,
      input => dependencies.getTranscriptionService().transcribe(input),
      preview => dependencies.runtime.send(IPC_CHANNELS.dictationPreview, preview),
      1000,
      process.env.MELULI_DICTATION_MODE !== "offline",
      process.env.MELULI_FINALIZE_OVERLAP === "1"
    ) : null;
    this.live = !this.experiment ? new LiveDictationService({
      open: (listener) => dependencies.getTranscriptionService().openLiveChannel(listener),
      onPreview: (preview) => dependencies.runtime.send(IPC_CHANNELS.dictationPreview, preview),
      backend: () => dependencies.getTranscriptionService().backend,
      modelId: () => dependencies.getTranscriptionService().modelId,
      log: (event, details) => console.log(`[LiveDictation] ${event}`, details)
    }) : null;
  }

  register(registry: IpcRegistry): void {
    const { dependencies } = this;
    registry.register(IPC_CHANNELS.dictationEnabled, () => Boolean(this.experiment));
    registry.register(IPC_CHANNELS.dictationBegin, async (_input, event) => {
      dependencies.runtime.assertRecordingOwner(event.sender.id);
      const experiment = this.experiment;
      if (!experiment && this.live) return dependencies.getTranscriptionService().streaming ? this.beginLive(this.live, event.sender) : null;
      if (!experiment) return null;
      const sessionId = await experiment.begin(); this.active = true;
      this.sessionId = sessionId; this.ownerId = event.sender.id;
      if (!this.observedSenders.has(event.sender)) {
        this.observedSenders.add(event.sender);
        const senderId = event.sender.id;
        event.sender.once("destroyed", () => {
          if (this.ownerId !== senderId) return;
          dependencies.getTranscriptionService().cancel();
          void experiment.cancel().catch(() => undefined);
          this.active = false; this.ownerId = null;
        });
      }
      return { sessionId };
    });
    registry.register(IPC_CHANNELS.dictationChunk, async (input, event) => {
      dependencies.runtime.assertRecordingOwner(event.sender.id);
      if (!this.experiment && this.live) {
        const chunk = dictationChunkSchema.parse(input);
        this.live.append(chunk.sessionId, chunk.sequence, chunk.pcm);
        return;
      }
      if (!this.experiment) throw new Error("Experimental dictation is disabled.");
      const chunk = dictationChunkSchema.parse(input);
      await this.experiment.append(chunk.sessionId, chunk.sequence, chunk.pcm);
    });
  }

  /** Recording stop: a running session is dropped (only by the window that owns the recording). */
  async stop(senderId: number): Promise<void> {
    if (this.live?.active) {
      this.dependencies.runtime.assertRecordingOwner(senderId);
      this.live.cancel();
      return;
    }
    if (!this.experiment || !this.active) return;
    this.dependencies.runtime.assertRecordingOwner(senderId);
    this.dependencies.getTranscriptionService().cancel();
    await this.experiment.cancel(); this.active = false;
  }

  /**
   * Transcription cancel: true when the service still had a session and it was dropped.
   * Reads the service's own `active`, not this class's flag, exactly as register.ts did.
   */
  async cancelIfRunning(): Promise<boolean> {
    if (this.liveStop) {
      this.liveStop.canceled = true;
      this.live?.cancel();
      return true;
    }
    if (!this.experiment?.active) return false;
    this.dependencies.getTranscriptionService().cancel();
    await this.experiment.cancel(); this.active = false;
    return true;
  }

  /**
   * Recording send-audio: when a session is running, finish it and store the transcript
   * through the workflow's prepared path; otherwise null, and the normal path runs.
   */
  finishIfActive(parsed: RecordingAudioPayload): Promise<TranscriptRecord> | null {
    if (this.live?.active) return this.finishLive(this.live, parsed);
    const experiment = this.experiment;
    if (!experiment || !this.active) return null;
    this.active = false;
    return this.finish(experiment, this.sessionId!, parsed);
  }

  private beginLive(live: LiveDictationService, sender: WebContents): { sessionId: string; live: true } {
    const sessionId = live.begin();
    if (!this.observedSenders.has(sender)) {
      this.observedSenders.add(sender);
      sender.once("destroyed", () => live.cancel());
    }
    return { sessionId, live: true };
  }

  /**
   * Stop on the streaming engine: the session's text when it is whole, otherwise the recording
   * decoded in full. Either way the workflow stores and pastes it once.
   */
  private async finishLive(live: LiveDictationService, parsed: RecordingAudioPayload): Promise<TranscriptRecord> {
    const stop = { canceled: false };
    this.liveStop = stop;
    const workflow = this.dependencies.getTranscriptionWorkflow();
    let result;
    try {
      beginPipelineTrace();
      pipelineTrace("live_finalize", "start");
      result = await live.finish(normalizeRecordingPcm(parsed.pcm), parsed.sampleRate);
      pipelineTrace("live_finalize", "end", { fallback: !result });
    } finally {
      if (this.liveStop === stop) this.liveStop = null;
    }
    if (stop.canceled) throw new TranscriptionCanceledError();
    return workflow.transcribeRecordingAudio(parsed, result ?? undefined);
  }

  private async finish(experiment: ExperimentalDictationService, sessionId: string, parsed: RecordingAudioPayload): Promise<TranscriptRecord> {
    const { dependencies } = this;
    try {
      beginPipelineTrace();
      if (!dependencies.isPackaged && process.env.MELULI_RESERVE_DURING_FINALIZE === "1") {
        dependencies.getTranscriptionWorkflow().prepareExperimentalInsertionReservation();
      }
      pipelineTrace("experimental_finalize", "start");
      const result = await experiment.finish(normalizeRecordingPcm(parsed.pcm), parsed.sampleRate);
      pipelineTrace("experimental_finalize", "end");
      const transcript = await dependencies.getTranscriptionWorkflow().transcribePreparedRecording({
        // Prepared ASR does not read this legacy-named field. Preserve an
        // exact source pointer for evidence/manual recovery, not its root.
        wavPath: join(this.root!, sessionId, "original.f32le"), sourceType: "microphone", durationMs: parsed.durationMs
      }, result);
      await experiment.recordWorkflowOutcome(sessionId,
        dependencies.runtime.getState().overlaySession?.phase === "paste_failed" ? "stored_paste_failed" : "store_workflow_completed", transcript.id)
        .catch(() => console.warn("[ExperimentalDictation] Workflow receipt could not be written; audio retained."));
      return transcript;
    } catch (error) {
      await dependencies.getTranscriptionWorkflow().abandonExperimentalInsertionReservation();
      await experiment.recordWorkflowOutcome(sessionId, "failed_or_canceled_audio_retained").catch(() => undefined);
      dependencies.getTranscriptionWorkflow().failPreparedRecording(error);
      throw error;
    } finally { this.sessionId = null; this.ownerId = null; }
  }
}
