import { useEffect, useLayoutEffect, useState } from "react";
import type {
  AccessibilityPermissionStatus,
  AppSettings,
  AppStateSnapshot,
  MicrophonePermissionStatus,
  ModelDownloadProgress,
  StoragePathsInfo
} from "@shared/types";
import { applyTheme } from "@/lib/theme";
import { isCanceledMessage } from "@shared/error-utils";

export function useAppState(windowMode: "main" | "overlay") {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [appState, setAppState] = useState<AppStateSnapshot>({
    status: "idle",
    timerStartedAt: null,
    processingStartedAt: null,
    processingEstimateMs: null,
    processingProgressRatio: null,
    lastError: null,
    overlaySession: null,
    holdKey: { status: "off" },
    update: { status: "off", version: null }
  });
  const [permissionStatus, setPermissionStatus] = useState<MicrophonePermissionStatus>("unknown");
  const [accessibilityPermissionStatus, setAccessibilityPermissionStatus] =
    useState<AccessibilityPermissionStatus>("unknown");
  const [modelProgress, setModelProgress] = useState<ModelDownloadProgress | null>(null);
  const [storagePaths, setStoragePaths] = useState<StoragePathsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let disposed = false;

    const refreshPermissions = async () => {
      const [nextPermission, nextAccessibilityPermission] = await Promise.all([
        window.ivritMenuBar.permissions.microphoneStatus(),
        window.ivritMenuBar.permissions.accessibilityStatus()
      ]);

      if (disposed) {
        return;
      }

      setPermissionStatus(nextPermission);
      setAccessibilityPermissionStatus(nextAccessibilityPermission);
    };

    const bootstrap = async () => {
      const [nextSettings, nextAppState, nextPermission, nextAccessibilityPermission, nextStoragePaths] = await Promise.all([
        window.ivritMenuBar.settings.get(),
        window.ivritMenuBar.app.state(),
        window.ivritMenuBar.permissions.microphoneStatus(),
        window.ivritMenuBar.permissions.accessibilityStatus(),
        windowMode === "main" ? window.ivritMenuBar.files.storagePaths() : Promise.resolve(null)
      ]);

      if (disposed) {
        return;
      }

      setSettings(nextSettings);
      setAppState(nextAppState);
      setPermissionStatus(nextPermission);
      setAccessibilityPermissionStatus(nextAccessibilityPermission);
      setStoragePaths(nextStoragePaths);
      setLoading(false);
    };

    void bootstrap().catch(() => { if (!disposed) setLoadFailed(true); });

    const unsubscribers = [window.ivritMenuBar.app.onState((snapshot) => setAppState(snapshot))];

    if (windowMode === "main") {
      unsubscribers.push(
        window.ivritMenuBar.model.onProgress((progress) => {
          setModelProgress(progress);
          setSettings((current) =>
            // A final progress event can arrive after the download promise.
            // It must not turn a completed or failed operation back into loading.
            current && current.modelState.downloadState !== "ready" && current.modelState.downloadState !== "error"
              ? {
                  ...current,
                  modelState: {
                    ...current.modelState,
                    downloadState: "downloading",
                    bytesDownloaded: progress.bytesDownloaded,
                    totalBytes: progress.totalBytes
                  }
                }
              : current
          );
        })
      );
    } else {
      unsubscribers.push(window.ivritMenuBar.settings.onChanged(setSettings));
    }

    unsubscribers.push(
      window.ivritMenuBar.transcription.onFailed((payload) => {
        if (isCanceledMessage(payload.message)) {
          setAppState((current) => ({ ...current, lastError: null }));
          return;
        }
        setAppState((current) => ({ ...current, lastError: payload.message }));
      })
    );

    const handleFocus = () => {
      void refreshPermissions();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);

    return () => {
      disposed = true;
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [windowMode]);

  const theme = settings?.theme;
  useLayoutEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  return {
    loading,
    loadFailed,
    settings,
    setSettings,
    appState,
    setAppState,
    permissionStatus,
    setPermissionStatus,
    accessibilityPermissionStatus,
    setAccessibilityPermissionStatus,
    modelProgress,
    setModelProgress,
    storagePaths
  };
}
