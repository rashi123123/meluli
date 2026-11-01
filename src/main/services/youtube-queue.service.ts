import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { transcriptionErrorPayloadSchema } from "@shared/schemas";
import type { AppStateSnapshot } from "@shared/types";
import { he } from "@shared/locale";
import type { AppDatabase } from "../db/database";
import { AppRuntime } from "../runtime";
import { AudioConverterService } from "./audio-converter.service";
import { isTranscriptionCanceledError, TranscriptionService } from "./transcription.service";
import { TranscriptionWorkflowService } from "./transcription-workflow.service";
import {
  isYouTubeDownloadCanceledError,
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
  private pendingStartScheduled = false;
  private activeAbort: AbortController | null = null;
  private disposed = false;
  private readonly onRuntimeState = (snapshot: AppStateSnapshot) => {
    if (snapshot.status === "idle" && snapshot.pendingYoutubeJob) {
      this.schedulePendingStart();
    }
  };

  constructor(private readonly dependencies: YouTubeQueueServiceDependencies) {}

  initialize(): void {
    this.dependencies.runtime.on("state", this.onRuntimeState);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dependencies.runtime.off("state", this.onRuntimeState);
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
    if (this.disposed) throw new Error(he.transcriptionCanceled);
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
    this.activeAbort.abort();
    this.dependencies.youtubeImportService.cancel();
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
    if (this.disposed || this.activeYouTubePromise || this.pendingStartScheduled) {
      return;
    }

    const snapshot = this.dependencies.runtime.getState();
    const pending = snapshot.pendingYoutubeJob;
    if (!pending || snapshot.status !== "idle") {
      return;
    }

    this.pendingStartScheduled = true;
    this.dependencies.runtime.updateState({
      pendingYoutubeJob: null,
      lastError: null
    });

    const controller = new AbortController();
    this.activeAbort = controller;
    const promise = (async () => {
      let downloadResult: Awaited<ReturnType<YouTubeImportService["downloadAudio"]>> | null = null;
      let wavPath: string | null = null;

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

        wavPath = join(this.dependencies.database.paths.userDataPath, `youtube-${randomUUID()}.wav`);
        await this.dependencies.audioConverter.convertInputToWav(downloadResult.audioPath, wavPath, controller.signal);
        controller.signal.throwIfAborted();
        await this.dependencies.transcriptionWorkflow.transcribeAndStore({
          wavPath,
          sourceType: "youtube",
          sourceTitle: downloadResult.sourceTitle,
          sourceUrl: downloadResult.sourceUrl,
          durationMs: downloadResult.durationMs
        });
      } catch (error) {
        if (controller.signal.aborted || isYouTubeDownloadCanceledError(error) || isTranscriptionCanceledError(error)) {
          this.dependencies.runtime.updateState({
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
      this.pendingStartScheduled = false;
      this.schedulePendingStart();
    });
  }
}
