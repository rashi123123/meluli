import { stat } from "node:fs/promises";
import { join } from "node:path";
import { app, dialog, shell, systemPreferences } from "electron";
import { AppError } from "@shared/errors/app-error";
import { ERROR_CODES } from "@shared/errors/error-codes";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import {
  microphonePermissionStatusSchema,
  modelDownloadProgressSchema
} from "@shared/schemas";
import type { AppSettings, MainView, OverlaySize } from "@shared/types";
import { AUDIO_IMPORT_EXTENSIONS } from "@shared/constants";
import type { ThemeId } from "@shared/themes";
import { he } from "@shared/locale";
import { AppRuntime } from "../runtime";
import type { AppDatabase } from "../db/database";
import { ModelManager } from "../services/model-manager.service";
import { SettingsService } from "../services/settings.service";
import { applyTranscriptEdit } from "../services/transcript-edit.service";
import { TranscriptionService } from "../services/transcription.service";
import { TextInsertionService } from "../services/text-insertion.service";
import { ShortcutManager } from "../shortcuts";
import { TranscriptionWorkflowService } from "../services/transcription-workflow.service";
import { YouTubeQueueService } from "../services/youtube-queue.service";
import {
  buildTranscriptSrt,
  buildTranscriptSrtFileName,
  writeTranscriptSrt
} from "../services/subtitle-export.service";
import { registerAppHandlers } from "./handlers/app.handlers";
import { registerFileHandlers } from "./handlers/files.handlers";
import { registerHistoryHandlers } from "./handlers/history.handlers";
import { registerModelHandlers } from "./handlers/model.handlers";
import { registerOverlayHandlers } from "./handlers/overlay.handlers";
import { registerPermissionHandlers } from "./handlers/permissions.handlers";
import { registerRecordingHandlers } from "./handlers/recording.handlers";
import { registerSettingsHandlers } from "./handlers/settings.handlers";
import { registerShortcutHandlers } from "./handlers/shortcut.handlers";
import { registerTranscriptionHandlers } from "./handlers/transcription.handlers";
import { registerYouTubeHandlers } from "./handlers/youtube.handlers";
import type { CallService } from "../services/calls/call.service";
import { registerCallHandlers } from "./handlers/call.handlers";
import type { HoldKeyService } from "../services/hold-key.service";
import type { UpdateService } from "../services/update.service";
import { INVOKE_CHANNEL_ACCESS, type InvokeChannelName } from "./policy";
import { IpcRegistry } from "./registry";
import { dictationChunkSchema } from "@shared/experimental-dictation";
import { ExperimentalDictationService, experimentalDictationRoot } from "../services/experimental-dictation.service";
import { beginPipelineTrace, pipelineTrace } from "../pipeline-trace";
import {
  assertSafeRecordingAudioPayload,
  assertSafeTextInsertionInput,
  assertValidIpcSender,
  createRendererSecurityEnvironment,
  isAllowedOpenExternalUrl
} from "../security";

interface RegisterIpcDependencies {
  database: AppDatabase;
  runtime: AppRuntime;
  settingsService: SettingsService;
  applyTheme: (theme: ThemeId) => void;
  getModelManager: () => ModelManager;
  getTranscriptionService: () => TranscriptionService;
  getTranscriptionWorkflow: () => TranscriptionWorkflowService;
  getYouTubeQueueService: () => YouTubeQueueService;
  shortcutManager: ShortcutManager;
  getTextInsertionService: () => TextInsertionService;
  holdKey: HoldKeyService;
  calls: CallService;
  updates: UpdateService;
  installUpdate: () => void;
  hideOverlay: () => boolean;
  setOverlaySize: (size: OverlaySize) => void;
  openOverlay: () => Promise<void>;
  retargetOverlay: () => Promise<void>;
  showMain: (view: MainView) => void;
  isPackaged: boolean;
}

function isMockMode(): boolean {
  return process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1";
}

export function microphoneStatus(): "granted" | "denied" | "not-determined" | "restricted" | "unknown" {
  if (isMockMode()) {
    return "granted";
  }

  try {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    return microphonePermissionStatusSchema.parse(status);
  } catch {
    return "unknown";
  }
}

function accessibilityStatus(prompt = false): "granted" | "denied" | "unknown" {
  if (isMockMode()) {
    return "granted";
  }

  if (process.platform !== "darwin") {
    return "unknown";
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt) ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

function openPrivacySettingsPane(kind: "Microphone" | "Accessibility" | "ListenEvent" | "AudioCapture"): Promise<boolean> {
  if (process.platform !== "darwin") {
    return Promise.resolve(false);
  }

  return shell
    .openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${kind}`)
    .then(() => true)
    .catch(() => false);
}

export function registerIpcHandlers(dependencies: RegisterIpcDependencies): void {
  const experimentRoot = experimentalDictationRoot(dependencies.isPackaged, dependencies.database.paths.userDataPath);
  const experiment = experimentRoot ? new ExperimentalDictationService(
    experimentRoot,
    input => dependencies.getTranscriptionService().transcribe(input),
    preview => dependencies.runtime.send(IPC_CHANNELS.dictationPreview, preview),
    1000,
    process.env.MELULI_DICTATION_MODE !== "offline",
    process.env.MELULI_FINALIZE_OVERLAP === "1"
  ) : null;
  let experimentActive = false;
  let experimentSessionId: string | null = null;
  let experimentOwnerId: number | null = null;
  const observedExperimentSenders = new WeakSet<Electron.WebContents>();
  const rendererSecurity = createRendererSecurityEnvironment({
    isPackaged: dependencies.isPackaged,
    rawDevServerUrl: process.env.ELECTRON_RENDERER_URL ?? null
  });
  const registry = new IpcRegistry({
    validateEvent: (channel, event) => {
      if (!(channel in INVOKE_CHANNEL_ACCESS)) {
        throw new AppError(ERROR_CODES.security, "Rejected IPC for unknown channel.", {
          channel
        });
      }

      assertValidIpcSender(channel as InvokeChannelName, event, dependencies.runtime, rendererSecurity);
    }
  });
  let modelProgressListenerAttached = false;
  registry.register(IPC_CHANNELS.dictationEnabled, () => Boolean(experiment));
  registry.register(IPC_CHANNELS.dictationBegin, async (_input, event) => {
    dependencies.runtime.assertRecordingOwner(event.sender.id);
    if (!experiment) return null;
    const sessionId = await experiment.begin(); experimentActive = true;
    experimentSessionId = sessionId; experimentOwnerId = event.sender.id;
    if (!observedExperimentSenders.has(event.sender)) {
      observedExperimentSenders.add(event.sender);
      const senderId = event.sender.id;
      event.sender.once("destroyed", () => {
        if (experimentOwnerId !== senderId) return;
        dependencies.getTranscriptionService().cancel();
        void experiment.cancel().catch(() => undefined);
        experimentActive = false; experimentOwnerId = null;
      });
    }
    return { sessionId };
  });
  registry.register(IPC_CHANNELS.dictationChunk, async (input, event) => {
    dependencies.runtime.assertRecordingOwner(event.sender.id);
    if (!experiment) throw new Error("Experimental dictation is disabled.");
    const chunk = dictationChunkSchema.parse(input);
    await experiment.append(chunk.sessionId, chunk.sequence, chunk.pcm);
  });
  let transcriptionProgressListenerAttached = false;

  const ensureModelProgressListener = () => {
    if (modelProgressListenerAttached) {
      return;
    }

    modelProgressListenerAttached = true;
    dependencies.getModelManager().on("progress", (payload) => {
      dependencies.runtime.sendTo(
        "main",
        IPC_CHANNELS.modelDownloadProgress,
        modelDownloadProgressSchema.parse(payload)
      );
    });
  };

  const ensureTranscriptionProgressListener = () => {
    if (transcriptionProgressListenerAttached) {
      return;
    }

    transcriptionProgressListenerAttached = true;
    dependencies.getTranscriptionService().on("progress", (payload) => {
      dependencies.runtime.send(IPC_CHANNELS.transcriptionProgress, payload);
    });
  };

  registerAppHandlers(registry, {
    getAppState: () => dependencies.runtime.getState(),
    getIsMockMode: () => isMockMode(),
    getVersion: () => app.getVersion(),
    onInstallUpdate: () => dependencies.installUpdate(),
    onOpenLicenses: async () => {
      const notices = join(app.isPackaged ? process.resourcesPath : process.cwd(), "THIRD_PARTY_NOTICES.md");
      // openPath reports a Mac with no app for .md files as a message, not a rejection.
      if (await shell.openPath(notices)) shell.showItemInFolder(notices);
    },
    onShowMain: (view) => dependencies.showMain(view)
  });

  registerRecordingHandlers(registry, {
    onStart: async (parsed, event) => {
      const previousStatus = dependencies.runtime.getState().status;
      dependencies.runtime.claimRecording(event.sender.id);
      pipelineTrace("recording_start_requested", "event");
      await dependencies.getTextInsertionService().whenCaptureSettled();
      const { status } = dependencies.runtime.getState();
      if (previousStatus === "paused" ? status !== "paused" : status !== "idle" && status !== "error") {
        dependencies.runtime.releaseRecording(event.sender.id);
        throw new Error("כבר יש הקלטה או עיבוד פעילים.");
      }
      if (previousStatus !== "paused") {
        if (dependencies.runtime.getWindowRoleForWebContents(event.sender) === "overlay") {
          dependencies.runtime.startOverlaySession(dependencies.getTextInsertionService().getCapturedTargetApplicationName());
        } else {
          dependencies.runtime.clearOverlaySession();
          dependencies.getTextInsertionService().clearTargetApplication();
        }
      }
      ensureTranscriptionProgressListener();
      void dependencies.getTranscriptionService().prewarm().catch((error) => {
        console.error("[IPC] microphone prewarm failed", {
          kind: error instanceof Error ? error.name : "UnknownError"
        });
      });

      return dependencies.runtime.updateState({
        status: "recording",
        timerStartedAt: parsed.startedAt,
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        lastError: null
      });
    },
    onPause: (parsed, event) => {
      dependencies.runtime.assertRecordingOwner(event.sender.id);
      return dependencies.runtime.updateState({
      status: "paused",
      timerStartedAt: Math.round(parsed.elapsedMs),
      activeSourceType: "microphone",
      currentYoutubeJob: null,
      lastError: null
    });
    },
    onStop: async (event) => {
      if (experiment && experimentActive) {
        dependencies.runtime.assertRecordingOwner(event.sender.id);
        dependencies.getTranscriptionService().cancel();
        await experiment.cancel(); experimentActive = false;
      }
      dependencies.runtime.releaseRecording(event.sender.id);
      dependencies.runtime.clearOverlaySession();
      dependencies.getTextInsertionService().clearTargetApplication();
      return dependencies.runtime.updateState({
      status: "idle",
      timerStartedAt: null,
      activeSourceType: null,
      currentYoutubeJob: null
    });
    },
    onSendAudio: async (parsed, event) => {
      dependencies.runtime.assertRecordingOwner(event.sender.id);
      pipelineTrace("capture", "event", { durationMs: parsed.durationMs, micReady: parsed.capturedAt?.micReady ?? null, stopped: parsed.capturedAt?.stopped ?? null });
      try {
        assertSafeRecordingAudioPayload(parsed);
        ensureTranscriptionProgressListener();
        dependencies.runtime.releaseRecording(event.sender.id);
        dependencies.runtime.updateState({ status: "processing", activeSourceType: "microphone", timerStartedAt: null });
        dependencies.runtime.updateOverlaySession({ phase: "processing" });
        if (experiment && experimentActive) {
          experimentActive = false;
          const sessionId = experimentSessionId!;
          try {
            beginPipelineTrace();
            if (!dependencies.isPackaged && process.env.MELULI_RESERVE_DURING_FINALIZE === "1") {
              dependencies.getTranscriptionWorkflow().prepareExperimentalInsertionReservation();
            }
            pipelineTrace("experimental_finalize", "start");
            const pcm = parsed.pcm instanceof ArrayBuffer ? new Float32Array(parsed.pcm)
              : parsed.pcm instanceof Float32Array ? parsed.pcm : Float32Array.from(parsed.pcm);
            const result = await experiment.finish(pcm, parsed.sampleRate);
            pipelineTrace("experimental_finalize", "end");
            const transcript = await dependencies.getTranscriptionWorkflow().transcribePreparedRecording({
              // Prepared ASR does not read this legacy-named field. Preserve an
              // exact source pointer for evidence/manual recovery, not its root.
              wavPath: join(experimentRoot!, sessionId, "original.f32le"), sourceType: "microphone", durationMs: parsed.durationMs
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
          } finally { experimentSessionId = null; experimentOwnerId = null; }
        }
        return await dependencies.getTranscriptionWorkflow().transcribeRecordingAudio(parsed);
      } catch (error) {
        const pcmLength =
          parsed.pcm instanceof ArrayBuffer ? parsed.pcm.byteLength / Float32Array.BYTES_PER_ELEMENT : parsed.pcm.length;
        console.error("[IPC] recording:send-audio failed", {
          kind: error instanceof Error ? error.name : "UnknownError",
          payloadSummary: {
            sampleRate: parsed.sampleRate,
            durationMs: parsed.durationMs,
            pcmLength
          }
        });
        throw error;
      }
    }
  });

  registerTranscriptionHandlers(registry, {
    onCancel: async () => {
      if (experiment?.active) {
        dependencies.getTranscriptionService().cancel();
        await experiment.cancel(); experimentActive = false;
        dependencies.runtime.clearOverlaySession();
        dependencies.getTextInsertionService().clearTargetApplication();
        dependencies.runtime.updateState({ status: "idle", activeSourceType: null, timerStartedAt: null });
        return true;
      }
      const workflow = dependencies.getTranscriptionWorkflow();
      const canceled = workflow.cancelActiveTranscription();
      if (canceled) await workflow.waitForSettled();
      return canceled;
    }
  });

  const withModelState = async (settings: AppSettings): Promise<AppSettings> => ({
    ...settings,
    modelState: await dependencies.getModelManager().getState(settings)
  });

  // The overlay outlives setup and model changes, which happen in the main window.
  const publishSettings = (settings: AppSettings): AppSettings => {
    dependencies.runtime.sendTo("overlay", IPC_CHANNELS.settingsChanged, settings);
    return settings;
  };

  registerModelHandlers(registry, {
    onStatus: () => dependencies.getModelManager().getState(),
    onDownload: async () => {
      ensureModelProgressListener();
      const model = await dependencies.getModelManager().downloadModel();
      publishSettings(await withModelState(dependencies.settingsService.getSettings()));
      return model;
    },
    onRemove: async () => {
      const status = dependencies.runtime.getState().status;
      const service = dependencies.getTranscriptionService();
      if ((status !== "idle" && status !== "error") || service.isBusy) throw new Error("אפשר להסיר את המודל לאחר סיום העבודה הפעילה.");
      service.releaseIfIdle();
      const model = dependencies.getModelManager().removeModel();
      publishSettings(await withModelState(dependencies.settingsService.getSettings()));
      return model;
    }
  });

  registerHistoryHandlers(registry, {
    onList: (parsed) => dependencies.database.transcriptRepository.list(parsed.limit, parsed.cursor),
    onGet: (id) => dependencies.database.transcriptRepository.getById(id),
    onSearch: (parsed) => dependencies.database.transcriptRepository.search(parsed.query, parsed.limit, parsed.cursor),
    onUpdate: ({ id, ...edit }) => {
      const repository = dependencies.database.transcriptRepository;
      const transcript = repository.getById(id);
      if (!transcript) return null;
      const { removeFillerWords } = dependencies.settingsService.getSettings();
      return repository.update(id, applyTranscriptEdit(transcript, edit, { removeFillerWords }));
    },
    onRestoreOriginal: (parsed) => dependencies.database.transcriptRepository.restoreOriginal(parsed.id),
    onDelete: (parsed) => dependencies.database.transcriptRepository.delete(parsed.id),
    onDeleteAll: async () => {
      await dependencies.calls.clearAll();
      return dependencies.database.transcriptRepository.deleteAll();
    }
  });

  registerSettingsHandlers(registry, {
    onGet: () => withModelState(dependencies.settingsService.getSettings()),
    onSet: async (parsed) => {
      let nextSettings: AppSettings;

      if (parsed.key === "shortcut") {
        const nextShortcut = dependencies.shortcutManager.setRecordingShortcut(String(parsed.value));
        nextSettings = dependencies.settingsService.setSetting("shortcut", nextShortcut);
      } else if (parsed.key === "overlayShortcut") {
        const nextShortcut = dependencies.shortcutManager.setOverlayShortcut(String(parsed.value));
        nextSettings = dependencies.settingsService.setSetting("overlayShortcut", nextShortcut);
      } else {
        nextSettings = dependencies.settingsService.setSetting(
          parsed.key,
          parsed.value as AppSettings[typeof parsed.key]
        );
      }

      if (parsed.key === "theme") dependencies.applyTheme(nextSettings.theme);

      if (parsed.key === "holdKey") void dependencies.holdKey.sync();
      if (parsed.key === "autoUpdate") dependencies.updates.sync();
      if (parsed.key === "callDetection") dependencies.calls.sync();

      return publishSettings(await withModelState(nextSettings));
    }
  });

  registerPermissionHandlers(registry, {
    onMicrophoneStatus: () => microphoneStatus(),
    onRequestMicrophone: async () => {
      if (isMockMode()) {
        return "granted";
      }

      try {
        await systemPreferences.askForMediaAccess("microphone");
      } catch {
        return "unknown";
      }

      return microphoneStatus();
    },
    onOpenMicrophoneSettings: () => openPrivacySettingsPane("Microphone"),
    onAccessibilityStatus: () => accessibilityStatus(false),
    onRequestAccessibility: () => accessibilityStatus(true),
    onOpenAccessibilitySettings: () => openPrivacySettingsPane("Accessibility"),
    onRequestHoldKey: () => dependencies.holdKey.requestPermission(),
    onOpenHoldKeySettings: () => openPrivacySettingsPane("ListenEvent")
  });

  registerCallHandlers(registry, {
    calls: dependencies.calls,
    onOpenAudioSettings: () => openPrivacySettingsPane("AudioCapture")
  });

  registerFileHandlers(registry, {
    onRevealPath: async (targetPath) => {
      if (!targetPath || targetPath !== dependencies.database.paths.userDataPath) {
        return false;
      }
      shell.showItemInFolder(String(targetPath));
      return true;
    },
    onOpenExternal: async (targetUrl) => {
      if (!targetUrl) {
        return false;
      }
      if (!isAllowedOpenExternalUrl(String(targetUrl))) {
        throw new AppError(ERROR_CODES.security, "Rejected external URL.", {
          url: String(targetUrl)
        });
      }
      await shell.openExternal(String(targetUrl));
      return true;
    },
    onStoragePaths: () => dependencies.database.paths,
    onImportAudio: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          {
            name: he.importAudio,
            extensions: [...AUDIO_IMPORT_EXTENSIONS]
          }
        ]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      ensureTranscriptionProgressListener();
      return dependencies.getTranscriptionWorkflow().transcribeImportedFile(result.filePaths[0]!);
    },
    onImportDroppedAudio: async (path) => {
      if (!(await stat(path)).isFile()) throw new Error(he.importAudioFailed);
      ensureTranscriptionProgressListener();
      return dependencies.getTranscriptionWorkflow().transcribeImportedFile(path);
    },
    onExportTranscriptSrt: async (parsed) => {
      const transcript = dependencies.database.transcriptRepository.getById(parsed.id);
      if (!transcript) {
        return false;
      }

      const srt = buildTranscriptSrt(transcript);
      if (!srt) {
        return false;
      }

      const defaultPath = join(
        dependencies.database.paths.transcriptsDir,
        buildTranscriptSrtFileName(transcript)
      );
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [
          {
            name: "SRT",
            extensions: ["srt"]
          }
        ]
      });

      if (result.canceled || !result.filePath) {
        return false;
      }

      await writeTranscriptSrt(result.filePath, srt);
      return true;
    }
  });

  registerYouTubeHandlers(registry, {
    onSubmit: (parsed) => {
      ensureTranscriptionProgressListener();
      return dependencies.getYouTubeQueueService().submit(parsed.url);
    },
    onCancelActive: async () => {
      const queue = dependencies.getYouTubeQueueService();
      const canceled = queue.cancelActive();
      if (canceled) await queue.waitForSettled();
      return canceled;
    },
    onCancelPending: () => dependencies.getYouTubeQueueService().cancelPending()
  });

  registerShortcutHandlers(registry, {
    onGet: () => dependencies.settingsService.getSettings().shortcut,
    onSet: (accelerator) => {
      const next = dependencies.shortcutManager.setRecordingShortcut(accelerator);
      dependencies.settingsService.setSetting("shortcut", next);
      return next;
    }
  });

  registerOverlayHandlers(registry, {
    onOpen: dependencies.openOverlay,
    onRetarget: dependencies.retargetOverlay,
    onReady: () => dependencies.runtime.setOverlayReady(),
    onHide: () => dependencies.hideOverlay(),
    onSetSize: dependencies.setOverlaySize,
    onSetHeldRecording: (reason) => dependencies.runtime.setHeldRecording(reason),
    onInsertText: (text) => {
      assertSafeTextInsertionInput(text);
      if (!dependencies.runtime.getState().overlaySession) {
        throw new AppError(ERROR_CODES.security, "Rejected text insertion without overlay session.");
      }
      const session = dependencies.runtime.getState().overlaySession!;
      if (session.phase !== "paste_failed" || session.transcriptText !== text) {
        throw new AppError(ERROR_CODES.security, "Rejected stale or duplicate paste.");
      }
      if (session.manualCopyOnly || (!dependencies.isPackaged && process.env.MELULI_PIPELINE_TRACE === "1")) {
        throw new AppError(ERROR_CODES.security, "Insertion outcome requires inspection. Copy the saved transcript from history; automatic redispatch is disabled in research mode.");
      }
      return dependencies.getTranscriptionWorkflow().retryPaste(text);
    }
  });
}
