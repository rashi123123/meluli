import { createContext, useContext } from "react";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import type { HeldRecording } from "@/hooks/use-recording";
import type {
  AccessibilityPermissionStatus,
  AppSettings,
  AppStateSnapshot,
  MainView,
  MicrophonePermissionStatus,
  ModelDownloadProgress,
  OnboardingOptionalAction,
  OnboardingStepKey,
  TranscriptEdit,
  TranscriptRecord
} from "@shared/types";

interface TranscriptsContextValue {
  errorMessage?: string | null;
  latestTranscript: TranscriptRecord | null;
  items: TranscriptRecord[];
  selectedId: string | null;
  selectedTranscript: TranscriptRecord | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  setSelectedId: (id: string) => void;
  prependTranscript: (transcript: TranscriptRecord, select?: boolean) => void;
  replaceTranscript: (transcript: TranscriptRecord) => void;
  updateTranscript: (id: string, edit: TranscriptEdit) => Promise<TranscriptRecord | null>;
  restoreTranscript: (id: string) => Promise<TranscriptRecord | null>;
  deleteTranscript: (id: string) => Promise<boolean>;
  deleteAllTranscripts: () => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  hasMore: boolean;
  isLoading: boolean;
}

export interface RecordingContextValue {
  livePreview?: import("@shared/experimental-dictation").DictationPreview | null;
  isPreparing: boolean;
  isResending: boolean;
  mediaStream: MediaStream | null;
  heldRecording: HeldRecording | null;
  startRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  abandonStart: () => Promise<boolean>;
  beginHold: () => boolean;
  /** Whether the failed audio held here is also complete on disk, in history, so a new hold may drop it. */
  heldRecordingSaved: () => boolean;
  endHold: () => void;
  /** Resolves true when the audio was kept for undo. */
  cancelRecording: () => Promise<boolean>;
  resendHeldRecording: () => Promise<void>;
  cancelProcessing: () => Promise<{ canceled: boolean; held: boolean }>;
  interruptRecording: (message: string) => Promise<void>;
  dropHeldRecording: () => void;
}

export interface AppContextValue {
  loading: boolean;
  loadFailed?: boolean;
  settings: AppSettings | null;
  appState: AppStateSnapshot;
  permissionStatus: MicrophonePermissionStatus;
  accessibilityPermissionStatus: AccessibilityPermissionStatus;
  modelProgress: ModelDownloadProgress | null;
  lastTranscript: TranscriptRecord | null;
  onboarding: ReturnType<typeof deriveOnboardingDisplayState> | null;
  activeView: MainView;
  setActiveView: (view: MainView) => void;
  errorMessage: string | null;
  setErrorMessage: (message: string | null) => void;
  transcripts: TranscriptsContextValue;
  recording: RecordingContextValue;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  requestMicrophonePermission: (options?: { advanceOnboarding?: boolean }) => Promise<MicrophonePermissionStatus>;
  requestAccessibilityPermission: () => Promise<AccessibilityPermissionStatus>;
  downloadModel: () => Promise<void>;
  importAudio: () => Promise<void>;
  importDroppedAudio: (file: File) => Promise<void>;
  submitYouTubeUrl: (url: string) => Promise<void>;
  cancelActiveYouTube: () => Promise<void>;
  cancelPendingYouTube: () => Promise<void>;
  revealStorage: () => Promise<void>;
  rerunOnboarding: () => Promise<void>;
  resetEverything: () => Promise<void>;
  trackOnboardingStepViewed: (step: OnboardingStepKey) => Promise<void>;
  completeOnboardingStep: (step: OnboardingStepKey, options?: { declined?: boolean }) => Promise<void>;
  continueOnboardingLater: (step: OnboardingStepKey) => Promise<void>;
  goBackOnboardingStep: () => Promise<void>;
  resumeOnboardingFlow: () => Promise<void>;
  dismissOnboardingOptionalAction: (action: OnboardingOptionalAction) => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useAppContext must be used within an app provider.");
  }
  return context;
}
