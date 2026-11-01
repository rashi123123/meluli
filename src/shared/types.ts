import type { ThemeId } from "./themes";

export type TranscriptSourceType = "microphone" | "imported_file" | "youtube" | "call";
export type TranscriptionBackend = "ct2" | "whispercpp" | "nemo";
export type MainView = "workspace" | "history" | "dictionary" | "settings" | "about" | "terms" | "privacy";
export type SpeedPreference = "accurate" | "balanced";
export type MicrophonePermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
export type AccessibilityPermissionStatus = "granted" | "denied" | "unknown";
export type ModelDownloadState = "missing" | "downloading" | "ready" | "error";
export type AppRuntimeStatus = "idle" | "recording" | "paused" | "youtube_downloading" | "processing" | "error";
export type OverlaySessionPhase = "recording" | "processing" | "paste_failed" | "success";
export type OverlaySessionErrorCode = "permission" | "target_unavailable" | "target_changed" | "secure_field" | "clipboard_changed" | "paste_failed";
export type OverlaySnapCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type OverlaySize = "compact" | "expanded";
export type OnboardingPhase = "not_started" | "needs_mic" | "needs_hold_key" | "needs_model" | "needs_first_transcript" | "activated";
export type OnboardingSurface = "flow" | "workspace";
export type OnboardingStepKey = "ready" | "microphone" | "hold_key" | "local_install" | "first_transcript" | "celebration";
export type OnboardingOptionalAction = "recording_shortcut" | "overlay_accessibility";
export type OnboardingTrackingEventName =
  | "onboarding_started"
  | "onboarding_step_viewed"
  | "onboarding_step_completed"
  | "onboarding_step_exited"
  | "first_transcript_started"
  | "first_transcript_completed"
  | "optional_step_completed"
  | "optional_step_dismissed"
  | "secondary_source_selected";

export interface ProcessingTelemetryBucket {
  sampleCount: number;
  averageSetupMs: number;
  averageMsPerAudioSecond: number;
}

/** Calls run piece by piece in the background, so no estimate is kept for them. */
export type ProcessingTelemetry = Record<
  Exclude<TranscriptSourceType, "call">,
  Record<SpeedPreference, ProcessingTelemetryBucket>
>;

export type OverlayPosition = "last" | "top" | "bottom" | "right" | "left" | "top-right" | "top-left" | "bottom-right" | "bottom-left";

export interface YouTubeJobInfo {
  url: string;
  title?: string | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: CallSpeaker;
}

export type CallSpeaker = "me" | "others";
export type CallAppKind = "zoom" | "teams" | "browser";
/** What a finished call left for the user to know. Failures stay listed so the audio can be retried. */
export type CallNotice = "no_speech" | "others_silent" | "partial_audio" | "low_disk" | "start_failed" | "needs_microphone";

export interface CallFailure {
  id: string;
  app: CallAppKind;
  startedAt: number;
}

export interface CallState {
  available: boolean;
  suggestion: CallAppKind | null;
  recording: { app: CallAppKind; startedAt: number } | null;
  processing: { progressRatio: number; waiting: boolean } | null;
  failures: CallFailure[];
  notice: CallNotice | null;
}

export type WorkerVadMode = "ct2_filter" | "whispercpp_native" | "none";

export interface WorkerVadCapability {
  supported: boolean;
  mode: WorkerVadMode;
  requiresModelPath: boolean;
}

export interface WorkerReadyV2 {
  type: "ready";
  protocolVersion: number;
  workerVersion: string;
  backend: TranscriptionBackend;
  capabilities: {
    vad: WorkerVadCapability;
  };
}

export interface WhisperCppVadConfig {
  enabled: boolean;
  modelPath: string;
  threshold: number;
  minSpeechDurationMs: number;
  minSilenceDurationMs: number;
  maxSpeechDurationSec: number | null;
  speechPadMs: number;
  segmentOverlapSec: number;
}

export interface TranscriptRecord {
  id: string;
  createdAt: number;
  sourceType: TranscriptSourceType;
  text: string;
  rawText?: string | null;
  paragraphs?: string[] | null;
  importedFileName?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  possibleTerms?: string[] | null;
  uncertainSegments?: string[] | null;
  durationMs?: number | null;
  backend?: TranscriptionBackend | null;
  modelId?: string | null;
  language?: string | null;
  segments?: TranscriptSegment[] | null;
  editedAt?: number | null;
}

/** Timed transcripts are edited cue by cue, so the main process keeps owning their timings. */
export type TranscriptEdit = { text: string } | { cueTexts: string[] };
export type TranscriptUpdateInput = TranscriptEdit & { id: string };

export interface TranscriptListResult {
  items: TranscriptRecord[];
  nextCursor: number | null;
}

export interface ModelState {
  id: string;
  url: string;
  fileName: string;
  filePath: string | null;
  downloadState: ModelDownloadState;
  bytesDownloaded: number;
  totalBytes: number | null;
  lastError?: string | null;
}

export interface OverlaySession {
  manualCopyOnly?: boolean;
  /** "unverified" means the paste was sent to the right app, which cannot show whether it landed. */
  insertionOutcome?: "confirmed" | "unverified" | "not_dispatched" | "unknown";
  /** Dictated with Meluli in front, so the text stays here instead of being pasted. */
  deliveredInApp?: boolean;
  id: string;
  phase: OverlaySessionPhase;
  transcriptId: string | null;
  transcriptText: string | null;
  targetAppName: string | null;
  lastErrorCode: OverlaySessionErrorCode | null;
}

export interface OnboardingState {
  phase: OnboardingPhase;
  surface: OnboardingSurface;
  activatedAt: number | null;
  completedOptionalActions: OnboardingOptionalAction[];
  dismissedOptionalActions: OnboardingOptionalAction[];
}

export interface OnboardingTrackingEvent {
  name: OnboardingTrackingEventName;
  occurredAt: number;
  phase: OnboardingPhase | null;
  step: OnboardingStepKey | null;
  sourceType: TranscriptSourceType | null;
  optionalAction: OnboardingOptionalAction | null;
}

export interface OnboardingTrackingState {
  events: OnboardingTrackingEvent[];
}

export interface OnboardingTrackingMetrics {
  onboardingStartedAt: number | null;
  microphonePermissionGrantRate: number;
  modelInstallCompletionRate: number;
  medianTimeToFirstTranscriptMs: number | null;
  firstTranscriptCompletionRate: number;
  firstTranscriptStartedAt: number | null;
  firstTranscriptCompletedAt: number | null;
  blockerExitCount: number;
  blockerExitRate: number;
  optionalStepUptake: Record<
    OnboardingOptionalAction,
    { completed: boolean; dismissed: boolean; status: "pending" | "completed" | "dismissed" }
  >;
}

export interface AppStateSnapshot {
  status: AppRuntimeStatus;
  timerStartedAt: number | null;
  processingStartedAt?: number | null;
  processingEstimateMs?: number | null;
  processingProgressRatio?: number | null;
  activeSourceType?: TranscriptSourceType | null;
  currentYoutubeJob?: YouTubeJobInfo | null;
  pendingYoutubeJob?: YouTubeJobInfo | null;
  lastError?: string | null;
  overlaySession?: OverlaySession | null;
  holdKey?: { status: HoldKeyStatus };
  update?: { status: UpdateStatus; version: string | null };
  call?: CallState;
  linkImportAvailable?: boolean;
}

export type UpdateStatus = "off" | "idle" | "downloading" | "ready" | "failed";

export type HoldKeyChoice = "off" | "right_option" | "right_command";
export type HoldKeyStatus = "off" | "needs_permission" | "ready" | "unavailable";
export type RecordingHoldPhase = "press" | "release";

export interface DictionaryEntry {
  id: string;
  heard: string;
  written: string;
}

export interface AppSettings {
  onboardingCompleted: boolean;
  onboarding: OnboardingState;
  onboardingTracking: OnboardingTrackingState;
  shortcut: string;
  overlayShortcut: string;
  overlayPosition: OverlayPosition;
  microphoneDeviceId: string | null;
  completionNotificationsEnabled: boolean;
  metalEnabled: boolean;
  launchAtLogin: boolean;
  theme: ThemeId;
  speedPreference: SpeedPreference;
  removeFillerWords: boolean;
  builtInTerms: boolean;
  dictionary: DictionaryEntry[];
  holdKey: HoldKeyChoice;
  spokenCommands: boolean;
  autoUpdate: boolean;
  callDetection: boolean;
  processingTelemetry: ProcessingTelemetry;
  modelState: ModelState;
}

export type RecordingPcmPayload = number[] | Float32Array | ArrayBuffer;

export interface RecordingAudioPayload {
  pcm: RecordingPcmPayload;
  sampleRate: number;
  durationMs: number;
  /** Epoch milliseconds for the timing trace. */
  capturedAt?: { micReady: number; stopped: number };
}

export interface TranscriptionStartInput {
  wavPath: string;
  sourceType: TranscriptSourceType;
  importedFileName?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  durationMs?: number | null;
}

export interface YouTubeSubmitInput {
  url: string;
}

export interface ImportAudioResult {
  canceled: boolean;
  fileName?: string;
  transcript?: TranscriptRecord;
}

export interface StoragePathsInfo {
  userDataPath: string;
  transcriptsDir: string;
  modelsDir: string;
}

export interface ModelDownloadProgress {
  bytesDownloaded: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface TranscriptionEventPayload {
  transcript: TranscriptRecord;
}

export interface TranscriptionErrorPayload {
  message: string;
}
