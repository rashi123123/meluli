import { stat } from "node:fs/promises";
import { app, BrowserWindow, dialog, shell, systemPreferences } from "electron";
import { accessibilityStatus, microphoneStatus, openPrivacySettingsPane } from "../system-permissions";
import type { AppServiceContainer } from "../services/container";
import { AppError } from "@shared/errors/app-error";
import { ERROR_CODES } from "@shared/errors/error-codes";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { AppSettings, MainView, OverlaySize } from "@shared/types";
import { AUDIO_IMPORT_EXTENSIONS, MAX_RECORDING_SAMPLE_RATE } from "@shared/constants";
import type { ThemeId } from "@shared/themes";
import { he } from "@shared/locale";
import { asrEngineSchema } from "@shared/schemas";
import { isFree, RECORDING_BUSY_MESSAGE } from "../runtime";
import { applyTranscriptEdit } from "../services/transcript-edit.service";
import { ShortcutManager } from "../shortcuts";
import { registerAppHandlers } from "./handlers/app.handlers";
import { registerFileHandlers } from "./handlers/files.handlers";
import { registerHistoryHandlers } from "./handlers/history.handlers";
import { registerModelHandlers } from "./handlers/model.handlers";
import { registerOverlayHandlers } from "./handlers/overlay.handlers";
import { registerPermissionHandlers } from "./handlers/permissions.handlers";
import { registerRecordingHandlers } from "./handlers/recording.handlers";
import { registerSettingsHandlers } from "./handlers/settings.handlers";
import { registerTranscriptionHandlers } from "./handlers/transcription.handlers";
import { registerYouTubeHandlers } from "./handlers/youtube.handlers";
import { registerCallHandlers } from "./handlers/call.handlers";
import { registerFlowHandlers } from "./handlers/flows.handlers";
import { IpcRegistry } from "./registry";
import { pipelineTrace } from "../diagnostics/pipeline-trace";
import { ExperimentalDictationIpc } from "./experimental-dictation.ipc";
import { exportTranscript } from "./transcript-export";
import {
  assertSafeRecordingAudioPayload,
  assertSafeTextInsertionInput,
  assertValidIpcSender,
  appRendererSecurity,
  isAllowedOpenExternalUrl
} from "../security";
import { isMockMode } from "../config/mock-mode";
import { thirdPartyNoticesPath } from "../config/paths";
import { normalizeRecordingPcm } from "../services/recording-wav";
import { deleteAllTranscripts, deleteTranscript } from "../services/transcript-files";

/** One chunk is about a second; anything past two seconds at the highest rate is not a chunk. */
const MAX_AUDIO_CHUNK_SAMPLES = 2 * MAX_RECORDING_SAMPLE_RATE;

/** The service container, plus what the app shell owns: windows, shortcuts and the theme. */
type RegisterIpcDependencies = Omit<AppServiceContainer, "dispose"> & {
  applyTheme: (theme: ThemeId) => void;
  shortcutManager: ShortcutManager;
  installUpdate: () => void;
  hideOverlay: () => boolean;
  setOverlaySize: (size: OverlaySize) => void;
  openOverlay: () => Promise<void>;
  retargetOverlay: () => Promise<void>;
  showMain: (view: MainView) => void;
  reportMainWindow: (sender: unknown, state: { view: MainView; keep: boolean }) => void;
  isPackaged: boolean;
};

export function registerIpcHandlers(dependencies: RegisterIpcDependencies): void {
  const experiment = new ExperimentalDictationIpc(dependencies);
  const rendererSecurity = appRendererSecurity();
  const registry = new IpcRegistry({
    validateEvent: (channel, event) => assertValidIpcSender(channel, event, dependencies.runtime, rendererSecurity)
  });
  experiment.register(registry);

  registerAppHandlers(registry, {
    getAppState: () => dependencies.runtime.getState(),
    getIsMockMode: () => isMockMode(),
    getVersion: () => app.getVersion(),
    onInstallUpdate: () => dependencies.installUpdate(),
    onOpenLicenses: async () => {
      const notices = thirdPartyNoticesPath(app);
      // openPath reports a Mac with no app for .md files as a message, not a rejection.
      if (await shell.openPath(notices)) shell.showItemInFolder(notices);
    },
    onShowMain: (view) => dependencies.showMain(view),
    onMainWindowReport: (sender, state) => dependencies.reportMainWindow(sender, state)
  });

  registerRecordingHandlers(registry, {
    onStart: async (parsed, event) => {
      const previousStatus = dependencies.runtime.getState().status;
      await dependencies.runtime.claimRecordingAfter(event.sender.id, async () => {
        pipelineTrace("recording_start_requested", "event");
        await dependencies.runtime.whenPasteRetrySettled();
        return dependencies.getTextInsertionService().whenCaptureSettled();
      });
      const { status } = dependencies.runtime.getState();
      if (previousStatus === "paused" ? status !== "paused" : !isFree(status)) {
        dependencies.runtime.releaseRecording(event.sender.id);
        throw new Error(RECORDING_BUSY_MESSAGE);
      }
      if (previousStatus !== "paused") {
        // A recording whose window went away before it stopped is kept, not continued.
        await dependencies.recordings?.keepOpenSpools();
        if (dependencies.runtime.getWindowRoleForWebContents(event.sender) === "overlay") {
          dependencies.runtime.startOverlaySession(dependencies.getTextInsertionService().getCapturedTargetApplicationName());
          dependencies.getTranscriptionWorkflow().routeOverlayFlow();
        } else {
          dependencies.runtime.clearOverlaySession();
          dependencies.getTextInsertionService().clearTargetApplication();
        }
      }
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
    onStop: async (input, event) => {
      if (input?.recordingId && dependencies.recordings) {
        const { recordings } = dependencies, id = input.recordingId;
        await (input.keepAudio ? recordings.keepSpool(id) : recordings.discardSpool(id))
          .catch(() => console.warn("[recording] recording audio could not be closed"));
      }
      await experiment.stop(event.sender.id);
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
      if (parsed.flushIncomplete) console.warn("[recording] final audio buffer missing; the transcript may lose its last word");
      try {
        assertSafeRecordingAudioPayload(parsed);
        dependencies.runtime.releaseRecording(event.sender.id);
        dependencies.runtime.updateState({ status: "processing", activeSourceType: "microphone", timerStartedAt: null });
        dependencies.runtime.updateOverlaySession({ phase: "processing" });
        const prepared = experiment.finishIfActive(parsed);
        if (prepared) return await prepared;
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
    },
    onAudioChunk: async (input, event) => {
      dependencies.runtime.assertRecordingOwner(event.sender.id);
      if (!dependencies.recordings) return false;
      const pcm = normalizeRecordingPcm(input.pcm);
      if (pcm.length > MAX_AUDIO_CHUNK_SAMPLES) throw new Error("Recording audio chunk is too large.");
      await dependencies.recordings.append(input.recordingId, input.sequence, input.sampleRate, pcm);
      return true;
    },
    onListStored: async () => dependencies.recordings?.list() ?? [],
    onTranscribeStored: (id) => dependencies.getTranscriptionWorkflow().transcribeStoredRecording(id),
    onDiscardStored: async (id) => { await dependencies.recordings?.remove(id); },
    onStoredAudio: async (id) => (await dependencies.recordings?.readAudio(id)) ?? null
  });

  registerTranscriptionHandlers(registry, {
    onCancel: async () => {
      if (await experiment.cancelIfRunning()) {
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

  // What a stored setting changes outside the store. Runs for every writer: the settings
  // screen, flows, and startup resets alike.
  const settingEffects: Partial<Record<keyof AppSettings, (settings: AppSettings) => void>> = {
    theme: (settings) => dependencies.applyTheme(settings.theme),
    holdKey: () => void dependencies.holdKey.sync(),
    autoUpdate: () => dependencies.updates.sync(),
    callDetection: () => dependencies.calls.sync(),
    keepRecordingAudio: (settings) => {
      if (!settings.keepRecordingAudio) void dependencies.recordings?.sweep(false).catch(() => undefined);
    }
  };
  // Written by the app itself; the model handlers publish model changes when they finish.
  const unpublished = new Set<keyof AppSettings>(["modelState", "processingTelemetry"]);
  dependencies.settingsService.onChange((settings, key) => {
    settingEffects[key]?.(settings);
    if (unpublished.has(key)) return;
    withModelState(settings).then(publishSettings).catch((error: unknown) => {
      console.warn("[Settings] overlay not updated:", error instanceof Error ? error.message : error);
    });
  });

  registerModelHandlers(registry, {
    onDownload: async () => {
      const model = await dependencies.getModelManager().downloadModel();
      publishSettings(await withModelState(dependencies.settingsService.getSettings()));
      return model;
    },
    onRemove: async () => {
      const status = dependencies.runtime.getState().status;
      const service = dependencies.getTranscriptionService();
      if (!isFree(status) || service.isBusy) throw new Error("אפשר להסיר את המודל לאחר סיום העבודה הפעילה.");
      service.releaseIfIdle();
      const model = dependencies.getModelManager().removeModel();
      publishSettings(await withModelState(dependencies.settingsService.getSettings()));
      return model;
    }
  });

  registerHistoryHandlers(registry, {
    onList: (parsed) => dependencies.database.transcriptRepository.list(parsed.limit, parsed.cursor),
    onSearch: (parsed) => dependencies.database.transcriptRepository.search(parsed.query, parsed.limit, parsed.cursor),
    onUpdate: ({ id, ...edit }) => {
      const repository = dependencies.database.transcriptRepository;
      const transcript = repository.getById(id);
      if (!transcript) return null;
      const { removeFillerWords, numbersAsDigits } = dependencies.settingsService.getSettings();
      return repository.update(id, applyTranscriptEdit(transcript, edit, { removeFillerWords, numbersAsDigits }));
    },
    onRestoreOriginal: (parsed) => dependencies.database.transcriptRepository.restoreOriginal(parsed.id),
    onDelete: async (parsed) => {
      const deleted = await deleteTranscript(dependencies.database, parsed.id);
      await dependencies.recordings?.removeForTranscript(parsed.id)
        .catch(() => console.warn("[history] the deleted transcript's audio could not be removed"));
      return deleted;
    },
    onDeleteAll: async () => {
      await dependencies.calls.clearAll();
      await dependencies.recordings?.clear();
      return deleteAllTranscripts(dependencies.database);
    }
  });

  registerFlowHandlers(registry, {
    settingsService: dependencies.settingsService,
    keys: dependencies.flowKeys,
    flows: dependencies.flows,
    chooseFlow: (flowId) => dependencies.getTranscriptionWorkflow().chooseOverlayFlow(flowId),
    choosePreview: (choice) => dependencies.getTranscriptionWorkflow().chooseFlowPreview(choice),
    revert: () => dependencies.getTranscriptionWorkflow().revertFlow(),
    transcribeTest: (payload) => {
      assertSafeRecordingAudioPayload(payload);
      return dependencies.getTranscriptionWorkflow().transcribeForFlowTest(payload);
    }
  });

  registerSettingsHandlers(registry, {
    onGet: () => withModelState(dependencies.settingsService.getSettings()),
    onSet: async (parsed) => {
      let nextSettings: AppSettings;

      if (parsed.key === "shortcut") {
        const nextShortcut = dependencies.shortcutManager.setRecordingShortcut(String(parsed.value));
        nextSettings = dependencies.settingsService.setSetting("shortcut", nextShortcut);
      } else if (parsed.key === "asrEngine") {
        // Never under a dictation, an import or a call piece: the switch drops the loaded model.
        const service = dependencies.getTranscriptionService();
        if (!isFree(dependencies.runtime.getState().status) || service.isBusy || dependencies.getModelManager().isDownloading) {
          throw new Error("אפשר להחליף מנוע לאחר סיום העבודה הפעילה.");
        }
        nextSettings = dependencies.settingsService.setSetting("asrEngine", asrEngineSchema.parse(parsed.value));
        service.releaseIfIdle();
      } else if (parsed.key === "overlayShortcut") {
        const nextShortcut = dependencies.shortcutManager.setOverlayShortcut(String(parsed.value));
        nextSettings = dependencies.settingsService.setSetting("overlayShortcut", nextShortcut);
      } else {
        nextSettings = dependencies.settingsService.setSetting(
          parsed.key,
          parsed.value as AppSettings[typeof parsed.key]
        );
      }

      return withModelState(nextSettings);
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

      return dependencies.getTranscriptionWorkflow().transcribeImportedFile(result.filePaths[0]!);
    },
    onImportDroppedAudio: async (path) => {
      if (!(await stat(path)).isFile()) throw new Error(he.importAudioFailed);
      return dependencies.getTranscriptionWorkflow().transcribeImportedFile(path);
    },
    onExportTranscript: async (parsed, event) => {
      const transcript = dependencies.database.transcriptRepository.getById(parsed.id);
      if (!transcript) return false;
      return exportTranscript(transcript, BrowserWindow.fromWebContents(event.sender), parsed.anchor, dependencies.database.paths.transcriptsDir);
    }
  });

  registerYouTubeHandlers(registry, {
    onSubmit: (parsed) => {
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
