import { rm } from "node:fs/promises";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { transcriptionErrorPayloadSchema } from "@shared/schemas";
import type { AppStateSnapshot } from "@shared/types";
import { he } from "@shared/locale";
import type { AppDatabase } from "../../db/database";
import { AppRuntime, RUNTIME_STATE_EVENT } from "../../runtime";
import { AudioConverterService } from "../audio-converter.service";
import { TranscriptionService } from "../transcription.service";
import { isTranscriptionCanceledError, TranscriptionCanceledError } from "../transcription-errors";
import { TranscriptionWorkflowService } from "../transcription-workflow.service";
import { temporaryAudioPath } from "../orphan-audio";
import {
  YouTubeImportService
} from "./youtube-import.service";

export interface YouTubeQueueServiceDependencies {
  database: AppDatabase;
  runtime: AppRuntime;
  audioConverter: AudioConverterService;
  transcriptionService: TranscriptionService;
  transcriptionWorkflow: TranscriptionWorkflowService;
  youtubeImportService: YouTubeImportService;
}

export class YouTubeQueueService {
  private activeYouTubePromise: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private disposed = false;
  private readonly onRuntimeState = (snapshot: AppStateSnapshot) => {
    if (snapshot.status === "idle" && snapshot.pendingYoutubeJob) {
      this.schedulePendingStart();
    }
  };

  constructor(private readonly dependencies: YouTubeQueueServiceDependencies) {}

  initialize(): void {
    this.dependencies.runtime.on(RUNTIME_STATE_EVENT, this.onRuntimeState);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dependencies.runtime.off(RUNTIME_STATE_EVENT, this.onRuntimeState);
    this.activeAbort?.abort();
    this.dependencies.youtubeImportService.dispose();
    this.dependencies.transcriptionService.cancel();
    await this.activeYouTubePromise;
  }

  schedulePendingStart(): void {
    if (this.disposed) return;
    queueMicrotask(() => {
      this.maybeStartPendingYoutubeJob();
    });
  }

  submit(url: string): AppStateSnapshot {
    if (this.disposed) throw new TranscriptionCanceledError();
    const snapshot = this.dependencies.runtime.getState();
    const isBusy =
      snapshot.status === "recording" ||
      snapshot.status === "paused" ||
      snapshot.status === "youtube_downloading" ||
      snapshot.status === "processing" ||
      Boolean(this.activeYouTubePromise);

    if (isBusy) {
      return this.dependencies.runtime.updateState({
        pendingYoutubeJob: {
          url,
          title: null
        },
        lastError: null
      });
    }

    this.dependencies.runtime.updateState({
      pendingYoutubeJob: {
        url,
        title: null
      }
    });
    this.schedulePendingStart();
    return this.dependencies.runtime.getState();
  }

  cancelActive(): boolean {
    if (!this.activeAbort || this.activeAbort.signal.aborted) return false;
    // Keep admission closed until download/conversion/inference and cleanup settle.
    // The abort stops the download; the transcription does not take the signal.
    this.activeAbort.abort();
    this.dependencies.transcriptionService.cancel();
    return true;
  }

  async waitForSettled(): Promise<void> {
    await this.activeYouTubePromise;
  }

  cancelPending(): boolean {
    const hadPending = Boolean(this.dependencies.runtime.getState().pendingYoutubeJob);
    if (!hadPending) {
      return false;
    }

    this.dependencies.runtime.updateState({
      pendingYoutubeJob: null
    });
    return true;
  }

  private maybeStartPendingYoutubeJob(): void {
    if (this.disposed || this.activeYouTubePromise) {
      return;
    }

    const snapshot = this.dependencies.runtime.getState();
    const pending = snapshot.pendingYoutubeJob;
    if (!pending || snapshot.status !== "idle" || this.dependencies.runtime.hasRecordingOwner()) {
      return;
    }

    this.dependencies.runtime.updateState({
      pendingYoutubeJob: null,
      lastError: null
    });

    const controller = new AbortController();
    this.activeAbort = controller;
    const promise = (async () => {
      let downloadResult: Awaited<ReturnType<YouTubeImportService["downloadAudio"]>> | null = null;
      let wavPath: string | null = null;
      let transcribing = false;

      try {
        this.dependencies.runtime.updateState({
          status: "youtube_downloading",
          timerStartedAt: null,
          activeSourceType: "youtube",
          currentYoutubeJob: {
            url: pending.url,
            title: pending.title ?? null
          },
          lastError: null
        });

        downloadResult = await this.dependencies.youtubeImportService.downloadAudio(pending.url, controller.signal);
        controller.signal.throwIfAborted();
        this.dependencies.runtime.updateState({
          currentYoutubeJob: {
            url: downloadResult.sourceUrl,
            title: downloadResult.sourceTitle
          }
        });

        wavPath = temporaryAudioPath(this.dependencies.database.paths.userDataPath, "youtube");
        await this.dependencies.audioConverter.convertInputToWav(downloadResult.audioPath, wavPath, controller.signal);
        controller.signal.throwIfAborted();
        transcribing = true;
        await this.dependencies.transcriptionWorkflow.transcribeAndStore({
          wavPath,
          sourceType: "youtube",
          sourceTitle: downloadResult.sourceTitle,
          sourceUrl: downloadResult.sourceUrl,
          durationMs: downloadResult.durationMs
        });
      } catch (error) {
        // Past the download, the workflow has already set the error state and told the windows.
        if (transcribing && !controller.signal.aborted && !isTranscriptionCanceledError(error)) return;
        if (controller.signal.aborted || isTranscriptionCanceledError(error)) {
          this.dependencies.runtime.updateJobState({
            status: "idle",
            timerStartedAt: null,
            activeSourceType: null,
            currentYoutubeJob: null,
            lastError: null
          });
          return;
        }

        const message = getHebrewErrorMessage(error, he.youtubeImportFailed);
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
      } finally {
        if (wavPath) {
          await rm(wavPath, { force: true }).catch(() => undefined);
        }
        if (downloadResult) {
          await downloadResult.cleanup().catch(() => undefined);
        }
      }
    })();

    this.activeYouTubePromise = promise.finally(() => {
      this.activeAbort = null;
      this.activeYouTubePromise = null;
      this.schedulePendingStart();
    });
  }
}
