import type {
  AppSettings,
  AccessibilityPermissionStatus,
  AppStateSnapshot,
  HoldKeyStatus,
  ImportAudioResult,
  MicrophonePermissionStatus,
  ModelDownloadProgress,
  ModelState,
  OverlaySize,
  OverlaySnapCorner,
  RecordingAudioPayload,
  RecordingHoldPhase,
  MainView,
  StoragePathsInfo,
  TranscriptListResult,
  TranscriptRecord,
  TranscriptUpdateInput,
  YouTubeSubmitInput
} from "./types";

export interface EventSubscription {
  (): void;
}

export interface IvritMenuBarApi {
  recording: {
    experimentalEnabled?(): Promise<boolean>;
    experimentalBegin?(): Promise<{ sessionId: string } | null>;
    experimentalChunk?(input: { sessionId: string; sequence: number; pcm: Float32Array }): Promise<void>;
    onExperimentalPreview?(listener: (preview: import("./experimental-dictation").DictationPreview) => void): EventSubscription;
    start(startedAt: number): Promise<AppStateSnapshot>;
    pause(elapsedMs: number): Promise<AppStateSnapshot>;
    stop(): Promise<AppStateSnapshot>;
    sendAudio(payload: RecordingAudioPayload): Promise<TranscriptRecord>;
  };
  transcription: {
    cancel(): Promise<boolean>;
    onProgress(listener: (progress: { stage: string }) => void): EventSubscription;
    onComplete(listener: (payload: { transcript: TranscriptRecord }) => void): EventSubscription;
    onFailed(listener: (payload: { message: string }) => void): EventSubscription;
  };
  history: {
    list(limit?: number, cursor?: number | null): Promise<TranscriptListResult>;
    search(query: string, limit?: number, cursor?: number | null): Promise<TranscriptListResult>;
    get(id: string): Promise<TranscriptRecord | null>;
    update(input: TranscriptUpdateInput): Promise<TranscriptRecord | null>;
    restoreOriginal(id: string): Promise<TranscriptRecord | null>;
    delete(id: string): Promise<boolean>;
    deleteAll(): Promise<boolean>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set<Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]): Promise<AppSettings>;
    onChanged(listener: (settings: AppSettings) => void): EventSubscription;
  };
  model: {
    status(): Promise<ModelState>;
    download(): Promise<ModelState>;
    remove(): Promise<ModelState>;
    onProgress(listener: (payload: ModelDownloadProgress) => void): EventSubscription;
  };
  permissions: {
    microphoneStatus(): Promise<MicrophonePermissionStatus>;
    requestMicrophone(): Promise<MicrophonePermissionStatus>;
    openMicrophoneSettings(): Promise<boolean>;
    accessibilityStatus(): Promise<AccessibilityPermissionStatus>;
    requestAccessibility(): Promise<AccessibilityPermissionStatus>;
    openAccessibilitySettings(): Promise<boolean>;
    requestHoldKey(): Promise<HoldKeyStatus>;
    openHoldKeySettings(): Promise<boolean>;
  };
  files: {
    importAudio(): Promise<ImportAudioResult>;
    importDroppedAudio(file: File): Promise<ImportAudioResult>;
    exportTranscriptSrt(id: string): Promise<boolean>;
    revealPath(path: string): Promise<boolean>;
    openExternal(url: string): Promise<boolean>;
    storagePaths(): Promise<StoragePathsInfo>;
  };
  youtube: {
    submit(input: YouTubeSubmitInput): Promise<AppStateSnapshot>;
    cancelActive(): Promise<boolean>;
    cancelPending(): Promise<boolean>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  shortcut: {
    get(): Promise<string>;
    set(accelerator: string): Promise<string>;
  };
  app: {
    state(): Promise<AppStateSnapshot>;
    isMockMode(): Promise<boolean>;
    version(): Promise<string>;
    showMain(view: MainView): Promise<void>;
    onState(listener: (snapshot: AppStateSnapshot) => void): EventSubscription;
    onNavigate(listener: (view: MainView) => void): EventSubscription;
    onHoldKeyPressed(listener: (pressed: boolean) => void): EventSubscription;
    installUpdate(): Promise<void>;
    openLicenses(): Promise<void>;
    onRecordingToggleRequested(listener: () => void): EventSubscription;
    onRecordingHoldRequested(listener: (phase: RecordingHoldPhase) => void): EventSubscription;
    onRecordingCancelRequested(listener: () => void): EventSubscription;
    onRecordingUndoRequested(listener: () => void): EventSubscription;
    onRecordingInterruptRequested(listener: () => void): EventSubscription;
  };
  overlay: {
    open(): Promise<void>;
    retarget(): Promise<void>;
    setHeldRecording(reason: "failed" | "canceled" | null): Promise<void>;
    ready(): Promise<void>;
    hide(): Promise<boolean>;
    setSize(size: OverlaySize): Promise<void>;
    onSnapPreview(listener: (corner: OverlaySnapCorner | null) => void): EventSubscription;
  };
  call: {
    accept(): Promise<void>;
    dismiss(): Promise<void>;
    stop(): Promise<void>;
    retry(id: string): Promise<void>;
    discard(id: string): Promise<void>;
    dismissNotice(): Promise<void>;
    openAudioSettings(): Promise<boolean>;
  };
  textInsert: {
    intoFocusedField(text: string): Promise<boolean>;
  };
}
