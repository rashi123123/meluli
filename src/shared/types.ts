import type * as z from "zod";
import type {
  holdKeyChoiceSchema,
  asrEngineSchema,
  mainViewSchema,
  onboardingOptionalActionSchema,
  onboardingPhaseSchema,
  onboardingStepKeySchema,
  onboardingSurfaceSchema,
  onboardingTrackingEventNameSchema,
  overlayPositionSchema
} from "./schemas";
import type { Flow, FlowConnection, FlowFailure, FlowIcon, FlowRunStatus } from "./flows";
import type { ThemeId } from "./themes";
import type { TERM_PACK_IDS } from "./constants";

export type TranscriptSourceType = "microphone" | "imported_file" | "youtube" | "call";
export type TranscriptionBackend = "ct2" | "whispercpp" | "nemo" | "sherpa-onnx";
export type MainView = z.infer<typeof mainViewSchema>;
export type SpeedPreference = "accurate" | "balanced";
export type MicrophonePermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
export type AccessibilityPermissionStatus = "granted" | "denied" | "unknown";
export type ModelDownloadState = "missing" | "downloading" | "ready" | "error";
export type AppRuntimeStatus = "idle" | "recording" | "paused" | "youtube_downloading" | "processing" | "error";
export type OverlaySessionPhase = "recording" | "processing" | "paste_failed" | "success";
export type OverlaySessionErrorCode = "permission" | "target_unavailable" | "target_changed" | "secure_field" | "clipboard_changed" | "clipboard_unavailable" | "paste_failed";
export type OverlaySnapCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type OverlaySize = "compact" | "expanded";
export type OnboardingPhase = z.infer<typeof onboardingPhaseSchema>;
export type OnboardingSurface = z.infer<typeof onboardingSurfaceSchema>;
export type OnboardingStepKey = z.infer<typeof onboardingStepKeySchema>;
export type OnboardingOptionalAction = z.infer<typeof onboardingOptionalActionSchema>;
export type OnboardingTrackingEventName = z.infer<typeof onboardingTrackingEventNameSchema>;

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

export type OverlayPosition = z.infer<typeof overlayPositionSchema>;

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
  /** The flow that rewrote this dictation before it was pasted. */
  flowName?: string | null;
  /** The dictation as spoken, before the flow. */
  flowInput?: string | null;
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
  /** The flow this dictation will run through; null runs none. Set when recording starts. */
  flowId?: string | null;
  /** Flows the overlay can switch to while recording. */
  flowChoices?: OverlayFlowChoice[];
  flowStatus?: FlowRunStatus;
  flowFailure?: FlowFailure;
}

export interface FlowsState {
  flows: Flow[];
  connections: (FlowConnection & { host: string | null; local: boolean; hasKey: boolean; ready: boolean })[];
  keyStorageAvailable: boolean;
}

export interface OverlayFlowChoice {
  id: string;
  name: string;
  icon: FlowIcon;
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

export type HoldKeyChoice = z.infer<typeof holdKeyChoiceSchema>;
export type AsrEngineChoice = z.infer<typeof asrEngineSchema>;
export type HoldKeyStatus = "off" | "needs_permission" | "ready" | "unavailable";
export type RecordingHoldPhase = "press" | "release";

export type TermPackId = (typeof TERM_PACK_IDS)[number];

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
  numbersAsDigits: boolean;
  formatForApp: boolean;
  termPacks: TermPackId[];
  dictionary: DictionaryEntry[];
  holdKey: HoldKeyChoice;
  /** Whisper, or the streaming zipformer (faster, lighter, live text). */
  asrEngine: AsrEngineChoice;
  spokenCommands: boolean;
  autoUpdate: boolean;
  callDetection: boolean;
  keepRecordingAudio: boolean;
  flows: Flow[];
  flowConnections: FlowConnection[];
  processingTelemetry: ProcessingTelemetry;
  modelState: ModelState;
}

/** A microphone recording kept on disk. */
export type TranscriptExportFormat = "md" | "vtt" | "srt";

export interface StoredRecording {
  id: string;
  createdAt: number;
  durationMs: number;
  /** `failed` waits to be transcribed; `kept` sits beside its transcript until it ages out. */
  status: "kept" | "failed";
  transcriptId: string | null;
}

export type RecordingPcmPayload = number[] | Float32Array | ArrayBuffer;

export interface RecordingAudioPayload {
  pcm: RecordingPcmPayload;
  sampleRate: number;
  durationMs: number;
  /** Epoch milliseconds for the timing trace. */
  capturedAt?: { micReady: number; stopped: number };
  /** The microphone's last samples, about 128 ms at most, never arrived. The rest is here. */
  flushIncomplete?: true;
  /** The copy main has been writing to disk while the recording lasted. */
  recordingId?: string;
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
