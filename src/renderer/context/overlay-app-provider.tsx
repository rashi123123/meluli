import { useEffect, useMemo, useRef, useState } from "react";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import type { AppSettings, MainView } from "@shared/types";
import { useAppState } from "@/hooks/use-app-state";
import { useRecording } from "@/hooks/use-recording";
import { AppContext, type AppContextValue } from "./app-context";

const noop = () => undefined;
const noopAsync = async () => undefined;
const noopFalseAsync = async () => false;
const noopNullAsync = async () => null;

const emptyTranscripts: AppContextValue["transcripts"] = {
  latestTranscript: null,
  items: [],
  selectedId: null,
  selectedTranscript: null,
  searchQuery: "",
  setSearchQuery: noop,
  setSelectedId: noop,
  prependTranscript: noop,
  updateTranscript: noopNullAsync,
  restoreTranscript: noopNullAsync,
  deleteTranscript: noopFalseAsync,
  deleteAllTranscripts: noopAsync,
  loadMore: noopAsync,
  refresh: noopAsync,
  hasMore: false,
  isLoading: false
};

export function OverlayAppProvider({
  children
}: {
  children: React.ReactNode;
}) {
  const appState = useAppState("overlay");
  const [activeView, setActiveView] = useState<MainView>("workspace");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);

  useEffect(() => {
    settingsRef.current = appState.settings;
  }, [appState.settings]);

  const onboarding = useMemo(
    () => (appState.settings ? deriveOnboardingDisplayState(appState.settings, appState.permissionStatus) : null),
    [appState.permissionStatus, appState.settings]
  );

  useEffect(() => {
    const unsubscribe = window.ivritMenuBar.transcription.onFailed(({ message }) => {
      if (message === he.transcriptionCanceled) {
        return;
      }

      setErrorMessage(message);
    });
    return unsubscribe;
  }, []);

  const refreshSettings = async () => {
    const nextSettings = await window.ivritMenuBar.settings.get();
    appState.setSettings(nextSettings);
  };

  const requestMicrophonePermission = async () => {
    const permission = await window.ivritMenuBar.permissions.requestMicrophone();
    appState.setPermissionStatus(permission);
    if (permission !== "granted") {
      throw new Error(he.permissionNeeded);
    }

    return permission;
  };

  const requestAccessibilityPermission = async () => {
    const permission = await window.ivritMenuBar.permissions.requestAccessibility();
    appState.setAccessibilityPermissionStatus(permission);
    return permission;
  };

  const recording = useRecording({
    windowMode: "overlay",
    timerStartedAt: appState.appState.timerStartedAt,
    microphoneDeviceId: appState.settings?.microphoneDeviceId ?? null,
    permissionStatus: appState.permissionStatus,
    requestPermission: requestMicrophonePermission,
    onTranscript: noop,
    onError: (message) => setErrorMessage(getHebrewErrorMessage(message, he.recordingFailed))
  });

  const value = useMemo<AppContextValue>(
    () => ({
      loading: appState.loading,
      loadFailed: appState.loadFailed,
      settings: appState.settings,
      appState: appState.appState,
      permissionStatus: appState.permissionStatus,
      accessibilityPermissionStatus: appState.accessibilityPermissionStatus,
      modelProgress: appState.modelProgress,
      storagePaths: appState.storagePaths,
      lastTranscript: null,
      onboarding,
      onboardingMetrics: null,
      activeView,
      setActiveView,
      errorMessage,
      setErrorMessage,
      transcripts: emptyTranscripts,
      recording,
      refreshSettings,
      updateSetting: async () => {
        throw new Error("Overlay provider does not support settings updates.");
      },
      setRecordingShortcut: async () => {
        throw new Error("Overlay provider does not support shortcut changes.");
      },
      setOverlayShortcut: async () => {
        throw new Error("Overlay provider does not support shortcut changes.");
      },
      requestMicrophonePermission,
      requestAccessibilityPermission,
      downloadModel: async () => {
        throw new Error("Overlay provider does not support model downloads.");
      },
      removeModel: async () => {
        throw new Error("Overlay provider does not support model removal.");
      },
      importAudio: async () => {
        throw new Error("Overlay provider does not support file imports.");
      },
      importDroppedAudio: async () => {
        throw new Error("Overlay provider does not support file imports.");
      },
      submitYouTubeUrl: async () => {
        throw new Error("Overlay provider does not support YouTube imports.");
      },
      cancelActiveYouTube: async () => {
        throw new Error("Overlay provider does not support YouTube imports.");
      },
      cancelPendingYouTube: async () => {
        throw new Error("Overlay provider does not support YouTube imports.");
      },
      revealStorage: async () => {
        throw new Error("Overlay provider does not support storage actions.");
      },
      rerunOnboarding: async () => {
        throw new Error("Overlay provider does not support onboarding mutations.");
      },
      resetEverything: async () => {
        throw new Error("Overlay provider does not support destructive mutations.");
      },
      trackOnboardingStepViewed: async () => undefined,
      completeOnboardingStep: async () => undefined,
      continueOnboardingLater: async () => undefined,
      goBackOnboardingStep: async () => undefined,
      resumeOnboardingFlow: async () => undefined,
      completeOnboardingOptionalAction: async () => undefined,
      dismissOnboardingOptionalAction: async () => undefined
    }),
    [
      activeView,
      appState.accessibilityPermissionStatus,
      appState.appState,
      appState.loading,
      appState.loadFailed,
      appState.modelProgress,
      appState.permissionStatus,
      appState.settings,
      appState.storagePaths,
      errorMessage,
      onboarding,
      recording
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
