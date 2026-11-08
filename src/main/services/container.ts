import type { MainView } from "@shared/types";
import { join } from "node:path";
import { ClipboardBridgeService } from "./insertion/clipboard-bridge.service";
import { autoUpdater, powerMonitor, safeStorage, systemPreferences, type App } from "electron";
import { createAppDatabase } from "../db/database";
import { helperBinary, resolveBinaryPaths } from "../config/paths";
import { UPDATE_FEED_URL } from "@shared/constants";
import { markPerformanceAudit } from "../diagnostics/perf-audit";
import { removeOrphanAudio } from "./orphan-audio";
import { AppRuntime, isRecording, RUNTIME_STATE_EVENT } from "../runtime";
import { AudioConverterService } from "./audio-converter.service";
import { HoldKeyService } from "./hold-key.service";
import { CallAudioClient } from "./calls/call-audio.client";
import { CallService } from "./calls/call.service";
import { supportsCallCapture } from "@shared/call-apps";
import { he } from "@shared/locale";
import { findVerifiedUpdate } from "./update-feed";
import { UpdateService } from "./update.service";
import { ModelManager } from "./model-manager.service";
import { SettingsService } from "./settings.service";
import { TextInsertionService } from "./insertion/text-insertion.service";
import { TranscriptionService } from "./transcription.service";
import { PRODUCT_ASR_ENGINE, resolveAsrEngine, type AsrEngine, type AsrEngineId } from "../config/asr-engine";
import { isTranscriptionCanceledError } from "./transcription-errors";
import { TranscriptionWorkflowService } from "./transcription-workflow.service";
import { experimentalDictationRoot } from "./experimental-dictation.service";
import { configurePipelineTrace } from "../diagnostics/pipeline-trace";
import { offlineResearchConfig } from "./offline-research-config";
import { InsertionJournal } from "./insertion/insertion-journal";
import { NativeInsertionClient, NATIVE_INSERTION_DEADLINE_MS } from "./insertion/native-insertion-client";
import { isLinkImportInstalled, YouTubeImportService } from "./youtube/youtube-import.service";
import { YouTubeQueueService } from "./youtube/youtube-queue.service";
import { isMockMode } from "../config/mock-mode";
import { RecordingAudioStore } from "./recording-audio-store";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { modelDownloadProgressSchema } from "@shared/schemas";
import { FlowKeyStore } from "./flows/flow-key-store";
import { FlowService } from "./flows/flow.service";

const RECORDING_SWEEP_INTERVAL_MS = 60 * 60_000;

export interface AppServiceContainer {
  dispose(): Promise<void>;
  database: ReturnType<typeof createAppDatabase>;
  runtime: AppRuntime;
  settingsService: SettingsService;
  holdKey: HoldKeyService;
  updates: UpdateService;
  calls: CallService;
  recordings: RecordingAudioStore | null;
  flowKeys: FlowKeyStore;
  flows: FlowService;
  getModelManager: () => ModelManager;
  getTranscriptionService: () => TranscriptionService;
  /** The speech engine this run uses. */
  /** The engine the next dictation runs: the person's choice, or a development override. */
  getAsrEngine: () => AsrEngine;
  getTranscriptionWorkflow: () => TranscriptionWorkflowService;
  getTextInsertionService: () => TextInsertionService;
  getYouTubeQueueService: () => YouTubeQueueService;
}

export function createAppServiceContainer(dependencies: {
  app: Pick<App, "getPath" | "isPackaged" | "setLoginItemSettings" | "getVersion" | "isInApplicationsFolder" | "getLoginItemSettings">;
  showMainWindow: (view?: MainView) => void;
}): AppServiceContainer {
  const database = createAppDatabase(dependencies.app.getPath("userData"));
  const runtime = new AppRuntime();
  const settingsService = new SettingsService(database.settingsRepository, dependencies.app);
  const binaryPaths = resolveBinaryPaths(dependencies.app);
  const research = offlineResearchConfig(dependencies.app.isPackaged, database.paths.userDataPath);
  // Research runs measure their own configured Whisper worker, whatever the profile chose.
  const getAsrEngine = (): AsrEngine => research ? PRODUCT_ASR_ENGINE
    : resolveAsrEngine(dependencies.app.isPackaged, settingsService.getSettings().asrEngine);
  const researchProfile = !dependencies.app.isPackaged && (Boolean(research) ||
    process.env.MELULI_PIPELINE_TRACE === "1" || process.env.MELULI_EXPERIMENTAL_DICTATION === "1");
  if (researchProfile) {
    experimentalDictationRoot(false, database.paths.userDataPath, { ...process.env, MELULI_EXPERIMENTAL_DICTATION: "1" });
    if (process.env.MELULI_PIPELINE_TRACE === "1") configurePipelineTrace(join(database.paths.userDataPath, "pipeline-events.jsonl"));
  } else {
    void removeOrphanAudio(database.paths.userDataPath);
    if (process.env.MELULI_DICTATION_TIMING === "1") configurePipelineTrace(join(database.paths.userDataPath, "dictation-timing.jsonl"), () => powerMonitor.getCurrentThermalState());
  }

  // Research runs archive every recording themselves and must not have it swept away.
  const recordings = researchProfile ? null : new RecordingAudioStore(join(database.paths.userDataPath, "recordings"), {
    onChange: () => runtime.sendTo("main", IPC_CHANNELS.recordingsChanged, null)
  });
  const sweepRecordings = () => {
    void recordings?.sweep(settingsService.getSettings().keepRecordingAudio)
      .catch(() => console.warn("[recordings] sweep failed"));
  };
  sweepRecordings();
  const recordingSweep = recordings ? setInterval(sweepRecordings, RECORDING_SWEEP_INTERVAL_MS) : null;
  recordingSweep?.unref();

  runtime.updateState({ linkImportAvailable: isLinkImportInstalled(binaryPaths) ||
    isMockMode() });

  /** One per engine: each keeps its own model folder and integrity record. */
  const modelManagers = new Map<AsrEngineId, ModelManager>();
  let audioConverter: AudioConverterService | null = null;
  let textInsertionService: TextInsertionService | null = null;
  let persistentNative: NativeInsertionClient | null = null;
  let transcriptionService: TranscriptionService | null = null;
  let transcriptionWorkflow: TranscriptionWorkflowService | null = null;
  let youtubeImportService: YouTubeImportService | null = null;
  let youtubeQueueService: YouTubeQueueService | null = null;
  const holdKey = new HoldKeyService(
    helperBinary(binaryPaths.resourcesBasePath, "meluli-holdkey"),
    () => isMockMode() ? "off" : settingsService.getSettings().holdKey,
    (status) => { runtime.updateState({ holdKey: { status } }); }
  );
  const updates = new UpdateService(
    autoUpdater,
    UPDATE_FEED_URL,
    // ShipIt cannot replace a copy run from the disk image or a translocated path.
    () => dependencies.app.isPackaged && process.platform === "darwin" && !isMockMode() && dependencies.app.isInApplicationsFolder() && settingsService.getSettings().autoUpdate,
    (status, version) => { runtime.updateState({ update: { status, version } }); },
    () => findVerifiedUpdate(UPDATE_FEED_URL, dependencies.app.getVersion())
  );
  const callTitles = { zoom: he.callTitleZoom, teams: he.callTitleTeams, browser: he.callTitleBrowser };
  const calls = new CallService({
    audio: new CallAudioClient(helperBinary(binaryPaths.resourcesBasePath, "meluli-callaudio")),
    runtime,
    root: join(database.paths.userDataPath, "calls"),
    isAvailable: () => process.platform === "darwin" && !isMockMode() && supportsCallCapture(process.getSystemVersion?.() ?? ""),
    isEnabled: () => settingsService.getSettings().callDetection,
    requestMicrophone: () => systemPreferences.askForMediaAccess("microphone"),
    transcribePiece: async (wavPath, durationMs) =>
      (await getTranscriptionService().transcribeBackground({ wavPath, durationMs, sourceType: "call" })).segments ?? [],
    isCanceled: isTranscriptionCanceledError,
    // Meluli's own windows also open the microphone outside a dictation (the onboarding check,
    // a flow's test recording). Both happen while Meluli is the app in front.
    ownsMicrophone: () => runtime.hasRecordingOwner() || isRecording(runtime.getState().status)
      || textInsertionService?.getFrontmostPid() === process.pid,
    saveTranscript: (record, app, segments) => {
      const service = getTranscriptionService();
      return getTranscriptionWorkflow().saveCallTranscript(
        record.id,
        { wavPath: "", sourceType: "call", sourceTitle: callTitles[app.kind], durationMs: (record.endedAt ?? record.startedAt) - record.startedAt },
        { text: segments.map((segment) => segment.text).join(" "), language: "he", segments, backend: service.backend, modelId: service.modelId }
      );
    }
  });
  runtime.on(RUNTIME_STATE_EVENT, () => {
    const status = runtime.getState().status;
    transcriptionService?.setRecordingActive(isRecording(status));
  });
  const getModelManager = (engine = getAsrEngine()) => {
    let manager = modelManagers.get(engine.id);
    if (!manager) {
      markPerformanceAudit("service:model-manager:init");
      manager = new ModelManager(database.paths.modelsDir, settingsService, (progress) =>
        runtime.sendTo("main", IPC_CHANNELS.modelDownloadProgress, modelDownloadProgressSchema.parse(progress)), engine);
      modelManagers.set(engine.id, manager);
    }
    return manager;
  };
  const getAudioConverter = () => audioConverter ??= new AudioConverterService();
  const getTextInsertionService = () =>
    textInsertionService ??= (() => {
      markPerformanceAudit("service:text-insertion:init");
      // Research-profile paste variants, chosen by launch switch; the product profile on macOS always gets the helper.
      const nativePaste = process.env.MELULI_NATIVE_PASTE ?? "";
      if (researchProfile && ["persistent-ax", "persistent-v5-ax", "persistent-v5-unicode", "persistent-v6-ax", "persistent-paste"].includes(nativePaste)) {
        const phase5 = nativePaste.startsWith("persistent-v5-");
        persistentNative = new NativeInsertionClient(join(process.env.MELULI_EXPERIMENT_ASSETS!, "build/native/" + (nativePaste === "persistent-paste" ? "persistent-paste" : nativePaste === "persistent-v6-ax" ? "phase6-insertion" : phase5 ? "phase5-insertion" : "persistent-insertion")),
          NATIVE_INSERTION_DEADLINE_MS, NATIVE_INSERTION_DEADLINE_MS, nativePaste === "persistent-paste" ? "native_paste" : nativePaste === "persistent-v5-unicode" ? "unicode_events" : "ax_selected_text");
      } else if (!researchProfile && process.platform === "darwin") {
        persistentNative = new NativeInsertionClient(helperBinary(binaryPaths.resourcesBasePath, "meluli-insertion"), NATIVE_INSERTION_DEADLINE_MS, NATIVE_INSERTION_DEADLINE_MS, "native_paste", true);
      }
      return new TextInsertionService(
        new ClipboardBridgeService(helperBinary(binaryPaths.resourcesBasePath, "meluli-clipboard")),
        () => runtime.releaseOverlayFocusForPaste(),
        researchProfile && nativePaste === "1"
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
          getModelPath: research?.getModelPath ?? (() => getModelManager().requireWorkerModelPath()),
          engine: research ? undefined : getAsrEngine,
          workerEnv: research?.workerEnv,
          modelId: research?.modelId
        },
        settingsService
      );
    })();
  const flowKeys = new FlowKeyStore(join(database.paths.userDataPath, "flow-keys.json"), safeStorage);
  // Research runs measure dictation alone, so nothing there is ever sent to a provider.
  // A key left behind by a connection that is gone is never kept.
  if (!researchProfile) flowKeys.retain(settingsService.getSettings().flowConnections.map((connection) => connection.id));
  const flows = new FlowService(() => researchProfile ? [] : settingsService.getSettings().flowConnections, flowKeys);
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
        recordings: recordings ?? undefined,
        flows: researchProfile ? undefined : flows,
        onSettled: () => {
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
    if (recordingSweep) clearInterval(recordingSweep);
    await calls.dispose();
    holdKey.dispose();
    updates.dispose();
    audioConverter?.dispose();
    const pending = [youtubeQueueService?.dispose(), transcriptionWorkflow?.dispose(), ...[...modelManagers.values()].map((manager) => manager.dispose())];
    transcriptionService?.dispose();
    await Promise.allSettled(pending);
    await persistentNative?.dispose();
    // A recording still being written is kept now rather than recovered on the next launch.
    await recordings?.keepOpenSpools().catch(() => undefined);
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
    recordings,
    flowKeys,
    flows,
    getModelManager,
    getTranscriptionService,
    getAsrEngine,
    getTranscriptionWorkflow,
    getTextInsertionService,
    getYouTubeQueueService
  };
}
