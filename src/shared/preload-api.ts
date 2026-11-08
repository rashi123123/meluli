import type { ConnectionTestResult, Flow, FlowApp, FlowConnection, FlowRunOutcome } from "./flows";
import type {
  AppSettings,
  FlowsState,
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
  StoredRecording,
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
    /** `live`: the streaming engine's session, which only shows text; otherwise a research archive. */
    experimentalBegin?(): Promise<{ sessionId: string; live?: boolean } | null>;
    experimentalChunk?(input: { sessionId: string; sequence: number; pcm: Float32Array }): Promise<void>;
    onExperimentalPreview?(listener: (preview: import("./experimental-dictation").DictationPreview) => void): EventSubscription;
    start(startedAt: number): Promise<AppStateSnapshot>;
    pause(elapsedMs: number): Promise<AppStateSnapshot>;
    /** `keepAudio` keeps what was written of a recording that was cut short; otherwise it is thrown away. */
    stop(options?: { recordingId?: string; keepAudio?: boolean }): Promise<AppStateSnapshot>;
    sendAudio(payload: RecordingAudioPayload): Promise<TranscriptRecord>;
    /** Resolves false when this run keeps no audio on disk. */
    audioChunk?(input: { recordingId: string; sequence: number; sampleRate: number; pcm: Float32Array }): Promise<boolean>;
  };
  transcription: {
    cancel(): Promise<boolean>;
    onComplete(listener: (payload: { transcript: TranscriptRecord }) => void): EventSubscription;
    onFailed(listener: (payload: { message: string }) => void): EventSubscription;
  };
  history: {
    list(limit?: number, cursor?: number | null): Promise<TranscriptListResult>;
    search(query: string, limit?: number, cursor?: number | null): Promise<TranscriptListResult>;
    update(input: TranscriptUpdateInput): Promise<TranscriptRecord | null>;
    restoreOriginal(id: string): Promise<TranscriptRecord | null>;
    delete(id: string): Promise<boolean>;
    deleteAll(): Promise<boolean>;
  };
  recordings: {
    list(): Promise<StoredRecording[]>;
    transcribe(id: string): Promise<{ transcript: TranscriptRecord; replaced: boolean }>;
    discard(id: string): Promise<void>;
    /** The kept WAV behind a recording, for playback. Null once it is gone. */
    audio(id: string): Promise<Uint8Array | null>;
    onChanged(listener: () => void): EventSubscription;
  };
  settings: {
    get(): Promise<AppSettings>;
    set<Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]): Promise<AppSettings>;
    onChanged(listener: (settings: AppSettings) => void): EventSubscription;
  };
  model: {
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
    /** Opens the export menu at `anchor`, then saves the chosen format. False when nothing was saved. */
    exportTranscript(id: string, anchor?: { x: number; y: number }): Promise<boolean>;
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
    /** The main window says which view it shows and whether it holds work a new window would lose. */
    reportMainWindow(state: { view: MainView; keep: boolean }): Promise<void>;
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
  flows: {
    state(): Promise<FlowsState>;
    save(flows: Flow[]): Promise<FlowsState>;
    /** `consent` is the user's press on the button that names the host. */
    saveConnection(connection: Omit<FlowConnection, "consentedHost">, apiKey: string | null, consent: boolean): Promise<{ consented: boolean; state: FlowsState }>;
    deleteConnection(id: string): Promise<FlowsState>;
    testConnection(id: string): Promise<ConnectionTestResult>;
    testRun(flow: Flow, text: string): Promise<FlowRunOutcome>;
    /** Transcribes a test recording without storing or pasting it. */
    testDictation(audio: RecordingAudioPayload): Promise<string>;
    listApps(): Promise<FlowApp[]>;
    /** Moves a connection first; steps without their own connection use it. */
    makeDefault(id: string): Promise<FlowsState>;
    choose(flowId: string | null): Promise<boolean>;
    preview(choice: "result" | "original"): Promise<void>;
    revert(): Promise<void>;
  };
}
