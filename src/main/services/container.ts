import { join } from "node:path";
import { ClipboardBridgeService } from "./clipboard-bridge.service";
import { autoUpdater, powerMonitor, systemPreferences, type App } from "electron";
import { createAppDatabase } from "../db/database";
import { resolveBinaryPaths } from "../config/paths";
import { UPDATE_FEED_URL } from "@shared/constants";
import { markPerformanceAudit } from "../perf-audit";
import { removeOrphanAudio } from "./orphan-audio";
import { AppRuntime } from "../runtime";
import { AudioConverterService } from "./audio-converter.service";
import { HoldKeyService } from "./hold-key.service";
import { CallAudioClient } from "./calls/call-audio.client";
import { CallService } from "./calls/call.service";
import { supportsCallCapture } from "@shared/call-apps";
import { he } from "@shared/locale";
import { UpdateService } from "./update.service";
import { ModelManager } from "./model-manager.service";
import { SettingsService } from "./settings.service";
import { TextInsertionService } from "./text-insertion.service";
import { isTranscriptionCanceledError, TranscriptionService } from "./transcription.service";
import { TranscriptionWorkflowService } from "./transcription-workflow.service";
import { experimentalDictationRoot } from "./experimental-dictation.service";
import { configurePipelineTrace } from "../pipeline-trace";
import { offlineResearchConfig } from "./offline-research-config";
import { InsertionJournal } from "./insertion-journal";
import { NativeInsertionClient } from "./native-insertion-client";
import { isLinkImportInstalled, YouTubeImportService } from "./youtube-import.service";
import { YouTubeQueueService } from "./youtube-queue.service";

export interface AppServiceContainer {
  dispose(): Promise<void>;
  database: ReturnType<typeof createAppDatabase>;
  runtime: AppRuntime;
  settingsService: SettingsService;
  holdKey: HoldKeyService;
  updates: UpdateService;
  calls: CallService;
  getModelManager: () => ModelManager;
  getAudioConverter: () => AudioConverterService;
  getTranscriptionService: () => TranscriptionService;
  getTranscriptionWorkflow: () => TranscriptionWorkflowService;
  getTextInsertionService: () => TextInsertionService;
  getYouTubeImportService: () => YouTubeImportService;
  getYouTubeQueueService: () => YouTubeQueueService;
}

export function createAppServiceContainer(dependencies: {
  app: Pick<App, "getPath" | "isPackaged" | "setLoginItemSettings" | "getLoginItemSettings">;
  showMainWindow: () => void;
  onTranscriptionSettled?: () => void;
}): AppServiceContainer {
  const database = createAppDatabase(dependencies.app.getPath("userData"));
  const runtime = new AppRuntime();
  const settingsService = new SettingsService(database.settingsRepository, dependencies.app);
  const binaryPaths = resolveBinaryPaths(dependencies.app);
  const research = offlineResearchConfig(dependencies.app.isPackaged, database.paths.userDataPath);
  const researchProfile = !dependencies.app.isPackaged && (Boolean(research) ||
    process.env.MELULI_PIPELINE_TRACE === "1" || process.env.MELULI_EXPERIMENTAL_DICTATION === "1");
  if (researchProfile) {
    experimentalDictationRoot(false, database.paths.userDataPath, { ...process.env, MELULI_EXPERIMENTAL_DICTATION: "1" });
    if (process.env.MELULI_PIPELINE_TRACE === "1") configurePipelineTrace(join(database.paths.userDataPath, "pipeline-events.jsonl"));
  } else {
    void removeOrphanAudio(database.paths.userDataPath);
    if (process.env.MELULI_DICTATION_TIMING === "1") configurePipelineTrace(join(database.paths.userDataPath, "dictation-timing.jsonl"), () => powerMonitor.getCurrentThermalState());
  }

  runtime.updateState({ linkImportAvailable: isLinkImportInstalled(binaryPaths) ||
    process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1" });

  let modelManager: ModelManager | null = null;
  let audioConverter: AudioConverterService | null = null;
  let textInsertionService: TextInsertionService | null = null;
  let persistentNative: NativeInsertionClient | null = null;
  let transcriptionService: TranscriptionService | null = null;
  let transcriptionWorkflow: TranscriptionWorkflowService | null = null;
  let youtubeImportService: YouTubeImportService | null = null;
  let youtubeQueueService: YouTubeQueueService | null = null;
  const holdKey = new HoldKeyService(
    join(binaryPaths.resourcesBasePath, "bin", "meluli-holdkey"),
    () => process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1" ? "off" : settingsService.getSettings().holdKey,
    (status) => { runtime.updateState({ holdKey: { status } }); }
  );
  const updates = new UpdateService(
    autoUpdater,
    UPDATE_FEED_URL,
    () => dependencies.app.isPackaged && process.platform === "darwin" && process.env.IVRIT_E2E_MOCK !== "1" &&
      process.env.IVRIT_USE_MOCK_SERVICES !== "1" && settingsService.getSettings().autoUpdate,
    (status, version) => { runtime.updateState({ update: { status, version } }); }
  );
  const callTitles = { zoom: he.callTitleZoom, teams: he.callTitleTeams, browser: he.callTitleBrowser };
  const calls = new CallService({
    audio: new CallAudioClient(join(binaryPaths.resourcesBasePath, "bin", "meluli-callaudio")),
    runtime,
    root: join(database.paths.userDataPath, "calls"),
    isAvailable: () => process.platform === "darwin" && process.env.IVRIT_E2E_MOCK !== "1" &&
      process.env.IVRIT_USE_MOCK_SERVICES !== "1" && supportsCallCapture(process.getSystemVersion?.() ?? ""),
    isEnabled: () => settingsService.getSettings().callDetection,
    requestMicrophone: () => systemPreferences.askForMediaAccess("microphone"),
    transcribePiece: async (wavPath, durationMs) =>
      (await getTranscriptionService().transcribeBackground({ wavPath, durationMs, sourceType: "call" })).segments ?? [],
    isCanceled: isTranscriptionCanceledError,
    saveTranscript: (record, app, segments) => {
      const service = getTranscriptionService();
      return getTranscriptionWorkflow().saveCallTranscript(
        { wavPath: "", sourceType: "call", sourceTitle: callTitles[app.kind], durationMs: (record.endedAt ?? record.startedAt) - record.startedAt },
        { text: segments.map((segment) => segment.text).join(" "), language: "he", segments, backend: service.backend, modelId: service.modelId }
      );
    }
  });
  runtime.on("state", () => {
    const status = runtime.getState().status;
    transcriptionService?.setRecordingActive(status === "recording" || status === "paused");
  });
  const getModelManager = () =>
    modelManager ??= (() => {
      markPerformanceAudit("service:model-manager:init");
      return new ModelManager(database.paths.modelsDir, settingsService, binaryPaths);
    })();
  const getAudioConverter = () => audioConverter ??= new AudioConverterService();
  const getTextInsertionService = () =>
    textInsertionService ??= (() => {
      markPerformanceAudit("service:text-insertion:init");
      if (researchProfile && ["persistent-ax", "persistent-v5-ax", "persistent-v5-unicode", "persistent-v6-ax", "persistent-paste"].includes(process.env.MELULI_NATIVE_PASTE ?? "")) {
        const phase5 = process.env.MELULI_NATIVE_PASTE!.startsWith("persistent-v5-");
        persistentNative = new NativeInsertionClient(join(process.env.MELULI_EXPERIMENT_ASSETS!, "build/native/" + (process.env.MELULI_NATIVE_PASTE === "persistent-paste" ? "persistent-paste" : process.env.MELULI_NATIVE_PASTE === "persistent-v6-ax" ? "phase6-insertion" : phase5 ? "phase5-insertion" : "persistent-insertion")),
          4000, 4000, process.env.MELULI_NATIVE_PASTE === "persistent-paste" ? "native_paste" : process.env.MELULI_NATIVE_PASTE === "persistent-v5-unicode" ? "unicode_events" : "ax_selected_text");
      } else if (!researchProfile && process.platform === "darwin") {
        persistentNative = new NativeInsertionClient(join(binaryPaths.resourcesBasePath, "bin", "meluli-insertion"), 4000, 4000, "native_paste", true);
      }
      return new TextInsertionService(
        new ClipboardBridgeService(join(binaryPaths.resourcesBasePath, "bin", "meluli-clipboard")),
        () => runtime.releaseOverlayFocusForPaste(),
        researchProfile && process.env.MELULI_NATIVE_PASTE === "1"
          ? join(process.env.MELULI_EXPERIMENT_ASSETS!, "build/native/native-paste") : undefined,
        persistentNative ?? undefined,
        !researchProfile
      );
    })();
  const getTranscriptionService = () =>
    transcriptionService ??= (() => {
      markPerformanceAudit("service:transcription:init");
      return new TranscriptionService(
        {
          binaryPaths: research ? { ...binaryPaths, whispercppWorkerBinaryPath: research.binary } : binaryPaths,
          getModelPath: research?.getModelPath ?? (() => getModelManager().requireModelPath()),
          workerEnv: research?.workerEnv,
          modelId: research?.modelId
        },
        settingsService
      );
    })();
  const getTranscriptionWorkflow = () =>
    transcriptionWorkflow ??= (() => {
      markPerformanceAudit("service:transcription-workflow:init");
      return new TranscriptionWorkflowService({
        database,
        runtime,
        settingsService,
        audioConverter: getAudioConverter(),
        transcriptionService: getTranscriptionService(),
        textInsertionService: getTextInsertionService(),
        showMainWindow: dependencies.showMainWindow,
        researchArchive: researchProfile,
        insertionJournal: researchProfile ? new InsertionJournal(join(database.paths.userDataPath, "insertion-journal")) : undefined,
        onSettled: () => {
          dependencies.onTranscriptionSettled?.();
          youtubeQueueService?.schedulePendingStart();
        }
      });
    })();
  const getYouTubeImportService = () =>
    youtubeImportService ??= (() => {
      markPerformanceAudit("service:youtube-import:init");
      return new YouTubeImportService({
        ytDlpBinaryPath: binaryPaths.ytDlpBinaryPath,
        denoBinaryPath: binaryPaths.denoBinaryPath
      });
    })();
  const getYouTubeQueueService = () => {
    if (youtubeQueueService) {
      return youtubeQueueService;
    }

    markPerformanceAudit("service:youtube-queue:init");
    youtubeQueueService = new YouTubeQueueService({
      database,
      runtime,
      audioConverter: getAudioConverter(),
      transcriptionService: getTranscriptionService(),
      transcriptionWorkflow: getTranscriptionWorkflow(),
      youtubeImportService: getYouTubeImportService()
    });
    youtubeQueueService.initialize();
    return youtubeQueueService;
  };

  let disposal: Promise<void> | null = null;
  const dispose = () => disposal ??= (async () => {
    await calls.dispose();
    holdKey.dispose();
    updates.dispose();
    audioConverter?.dispose();
    const pending = [youtubeQueueService?.dispose(), transcriptionWorkflow?.dispose(), modelManager?.dispose()];
    youtubeImportService?.dispose();
    transcriptionService?.dispose();
    await Promise.allSettled(pending);
    await persistentNative?.dispose();
    runtime.removeAllListeners();
    if (database.db?.open) database.db.close();
  })();

  return {
    dispose,
    database,
    runtime,
    settingsService,
    holdKey,
    updates,
    calls,
    getModelManager,
    getAudioConverter,
    getTranscriptionService,
    getTranscriptionWorkflow,
    getTextInsertionService,
    getYouTubeImportService,
    getYouTubeQueueService
  };
}
