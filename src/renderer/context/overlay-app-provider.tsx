import { useEffect, useMemo, useState } from "react";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { getHebrewErrorMessage, isCanceledMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import { useAppState } from "@/hooks/use-app-state";
import { useRecording } from "@/hooks/use-recording";
import { OverlayContext, type OverlayContextValue } from "./overlay-context";

const noop = () => undefined;
export function OverlayAppProvider({
  children
}: {
  children: React.ReactNode;
}) {
  const appState = useAppState("overlay");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onboarding = useMemo(
    () => (appState.settings ? deriveOnboardingDisplayState(appState.settings, appState.permissionStatus) : null),
    [appState.permissionStatus, appState.settings]
  );

  useEffect(() => {
    const unsubscribe = window.ivritMenuBar.transcription.onFailed(({ message }) => {
      if (isCanceledMessage(message)) {
        return;
      }

      setErrorMessage(message);
    });
    return unsubscribe;
  }, []);

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

  // useRecording returns a new object on every render, so this value changes with each one.
  const value: OverlayContextValue = {
    loading: appState.loading,
    settings: appState.settings,
    appState: appState.appState,
    permissionStatus: appState.permissionStatus,
    accessibilityPermissionStatus: appState.accessibilityPermissionStatus,
    onboarding,
    errorMessage,
    setErrorMessage,
    recording,
    requestAccessibilityPermission
  };

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}
