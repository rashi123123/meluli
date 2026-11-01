import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  appendOnboardingTrackingEvent,
  buildOnboardingTrackingMetrics,
  deriveOnboardingDisplayState
} from "@shared/onboarding";
import { createDefaultOnboardingState, createDefaultOnboardingTrackingState } from "@shared/onboarding-defaults";
import { he } from "@shared/locale";
import { getHebrewErrorMessage } from "@shared/error-utils";
import type { ImportAudioResult } from "@shared/types";
import type {
  AppSettings,
  MainView,
  OnboardingOptionalAction,
  OnboardingStepKey,
  OnboardingTrackingEvent,
  TranscriptRecord,
  TranscriptSourceType
} from "@shared/types";
import { useAppState } from "@/hooks/use-app-state";
import { useRecording } from "@/hooks/use-recording";
import { useTranscripts } from "@/hooks/use-transcripts";
import { AppContext, type AppContextValue } from "./app-context";

export function MainAppProvider({
  children
}: {
  children: React.ReactNode;
}) {
  const appState = useAppState("main");
  const [activeView, setActiveView] = useState<MainView>("workspace");
  const transcripts = useTranscripts({
    enabled: true,
    loadLatest: true,
    loadHistory: activeView === "history" || activeView === "workspace"
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const onboardingQueueRef = useRef(Promise.resolve());
  const activationTranscriptIdRef = useRef<string | null>(null);

  const setSettingsState = (next: AppSettings | ((current: AppSettings | null) => AppSettings | null)) => {
    appState.setSettings((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      settingsRef.current = resolved;
      return resolved;
    });
  };

  useEffect(() => {
    settingsRef.current = appState.settings;
  }, [appState.settings]);

  const onboarding = useMemo(
    () => (appState.settings ? deriveOnboardingDisplayState(appState.settings, appState.permissionStatus) : null),
    [appState.permissionStatus, appState.settings]
  );
  const onboardingMetrics = useMemo(
    () => (appState.settings ? buildOnboardingTrackingMetrics(appState.settings.onboardingTracking) : null),
    [appState.settings]
  );

  const mutateOnboarding = useEffectEvent(
    async (
      mutate: (current: AppSettings) => {
        onboarding?: AppSettings["onboarding"];
        events?: Array<
          Pick<OnboardingTrackingEvent, "name"> &
            Partial<Omit<OnboardingTrackingEvent, "name">>
        >;
      } | null
    ) => {
      const run = async () => {
        const current = settingsRef.current;
        if (!current) {
          return;
        }

        const next = mutate(current);
        if (!next) {
          return;
        }

        const nextOnboarding = next.onboarding ?? current.onboarding;
        const nextTracking = (next.events ?? []).reduce((tracking, event) => {
          const normalizedEvent: OnboardingTrackingEvent = {
            name: event.name,
            occurredAt: event.occurredAt ?? Date.now(),
            phase: event.phase ?? nextOnboarding.phase,
            step: event.step ?? null,
            sourceType: event.sourceType ?? null,
            optionalAction: event.optionalAction ?? null
          };
          return appendOnboardingTrackingEvent(tracking, normalizedEvent);
        }, current.onboardingTracking);
        const nextLegacyValue = nextOnboarding.phase === "activated";

        let resolved = current;
        if (JSON.stringify(current.onboardingTracking) !== JSON.stringify(nextTracking)) {
          resolved = await window.ivritMenuBar.settings.set("onboardingTracking", nextTracking);
        }
        if (JSON.stringify(resolved.onboarding) !== JSON.stringify(nextOnboarding)) {
          resolved = await window.ivritMenuBar.settings.set("onboarding", nextOnboarding);
        }
        if (resolved.onboardingCompleted !== nextLegacyValue) {
          resolved = await window.ivritMenuBar.settings.set("onboardingCompleted", nextLegacyValue);
        }

        if (resolved !== current) {
          // A settings response may predate download progress or completion.
          // This queue owns onboarding fields; preserve live model state.
          setSettingsState(latest => latest ? {
            ...latest,
            onboarding: resolved.onboarding,
            onboardingTracking: resolved.onboardingTracking,
            onboardingCompleted: resolved.onboardingCompleted
          } : resolved);
        }
      };

      onboardingQueueRef.current = onboardingQueueRef.current.then(run, run);

      await onboardingQueueRef.current;
    }
  );

  const advanceToNextOnboardingPhase = useEffectEvent((current: AppSettings, permission = appState.permissionStatus) => {
    if (permission !== "granted") {
      return {
        ...current.onboarding,
        phase: "needs_mic" as const,
        surface: current.onboarding.surface
      };
    }

    if (current.modelState.downloadState !== "ready") {
      return {
        ...current.onboarding,
        phase: "needs_model" as const,
        surface: current.onboarding.surface
      };
    }

    return {
      ...current.onboarding,
      phase: "needs_first_transcript" as const,
      surface: "workspace" as const
    };
  });

  const trackSecondarySourceSelection = useEffectEvent(async (sourceType: Extract<TranscriptSourceType, "imported_file" | "youtube">) => {
    const current = settingsRef.current;
    if (!current || current.onboarding.phase === "activated") {
      return;
    }

    await mutateOnboarding(() => ({
      events: [
        {
          name: "secondary_source_selected",
          sourceType
        }
      ]
    }));
  });

  useEffect(() => {
    if (onboarding?.showFlow) setActiveView("workspace");
  }, [onboarding?.showFlow]);

  useEffect(() => {
    if (!appState.settings || !onboarding) {
      return;
    }

    if (
      appState.settings.onboarding.phase === onboarding.phase &&
      appState.settings.onboarding.surface === onboarding.surface &&
      appState.settings.onboardingCompleted === onboarding.activated
    ) {
      return;
    }

    void mutateOnboarding((current) => ({
      onboarding: {
        ...current.onboarding,
        phase: onboarding.phase,
        surface: onboarding.surface,
        activatedAt: onboarding.activated ? current.onboarding.activatedAt : null
      }
    }));
  }, [appState.settings, mutateOnboarding, onboarding]);

  const handleTranscriptReady = useEffectEvent(async (transcript: TranscriptRecord) => {
    // A job can finish while someone reads or edits in History, so it never takes the screen.
    transcripts.prependTranscript(transcript, activeView !== "history");

    if (transcript.sourceType !== "microphone") {
      return;
    }

    const current = settingsRef.current;
    if (!current || current.onboarding.phase === "activated" || activationTranscriptIdRef.current === transcript.id) {
      return;
    }

    activationTranscriptIdRef.current = transcript.id;
    const occurredAt = Date.now();
    await mutateOnboarding((latest) => {
      if (latest.onboarding.phase === "activated") {
        return null;
      }

      return {
        onboarding: {
          ...latest.onboarding,
          phase: "activated",
          surface: "workspace",
          activatedAt: latest.onboarding.activatedAt ?? occurredAt
        },
        events: [
          {
            name: "onboarding_step_completed",
            phase: "needs_first_transcript",
            step: "first_transcript",
            sourceType: "microphone",
            occurredAt
          },
          {
            name: "first_transcript_completed",
            phase: "activated",
            step: "first_transcript",
            sourceType: "microphone",
            occurredAt
          }
        ]
      };
    });
  });

  useEffect(() => {
    const unsubscribe = window.ivritMenuBar.transcription.onComplete(({ transcript }) => {
      void handleTranscriptReady(transcript);
    });
    return unsubscribe;
  }, [handleTranscriptReady]);

  useEffect(() => {
    return window.ivritMenuBar.app.onNavigate((view) => {
      setActiveView(view);
    });
  }, []);

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
    setSettingsState(nextSettings);
  };

  const updateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const nextSettings = await window.ivritMenuBar.settings.set(key, value);
    setSettingsState(nextSettings);
  };

  const requestMicrophonePermission = async (options: { advanceOnboarding?: boolean } = {}) => {
    const permission = await window.ivritMenuBar.permissions.requestMicrophone();
    appState.setPermissionStatus(permission);
    if (permission !== "granted") {
      throw new Error(he.permissionNeeded);
    }

    const current = settingsRef.current;
    if (options.advanceOnboarding !== false && current && current.onboarding.phase !== "activated") {
      await mutateOnboarding((latest) => ({
        onboarding: advanceToNextOnboardingPhase(latest, permission),
        events:
          latest.onboarding.phase === "needs_mic"
            ? [
                {
                  name: "onboarding_step_completed",
                  step: "microphone",
                  phase: "needs_mic"
                }
              ]
            : []
      }));
    }

    return permission;
  };

  const requestAccessibilityPermission = async () => {
    const permission = await window.ivritMenuBar.permissions.requestAccessibility();
    appState.setAccessibilityPermissionStatus(permission);
    return permission;
  };

  const setRecordingShortcut = async (shortcut: string) => {
    const nextSettings = await window.ivritMenuBar.settings.set("shortcut", shortcut);
    setSettingsState(nextSettings);
  };

  const setOverlayShortcut = async (shortcut: string) => {
    const nextSettings = await window.ivritMenuBar.settings.set("overlayShortcut", shortcut);
    setSettingsState(nextSettings);
  };

  const downloadModel = async () => {
    appState.setModelProgress({
      bytesDownloaded: 0,
      totalBytes: null,
      percent: null
    });
    setSettingsState((current) =>
      current
        ? {
            ...current,
            modelState: {
              ...current.modelState,
              downloadState: "downloading",
              lastError: null
            }
          }
        : current
    );

    try {
      const nextModel = await window.ivritMenuBar.model.download();
      setSettingsState((current) => (current ? { ...current, modelState: nextModel } : current));
      appState.setModelProgress(null);
      const current = settingsRef.current;
      if (current && current.onboarding.phase !== "activated") {
        await mutateOnboarding((latest) => ({
          onboarding: latest.onboarding.surface === "flow" ? latest.onboarding : advanceToNextOnboardingPhase({ ...latest, modelState: nextModel }),
          events:
            latest.onboarding.phase === "needs_model"
              ? [
                  {
                    name: "onboarding_step_completed",
                    step: "local_install",
                    phase: "needs_model"
                  }
                ]
              : []
        }));
      }
    } catch (error) {
      const message = getHebrewErrorMessage(error, he.modelDownloadFailed);
      setSettingsState((current) =>
        current
          ? {
              ...current,
              modelState: {
                ...current.modelState,
                downloadState: "error",
                lastError: message
              }
            }
          : current
      );
      throw error;
    }
  };

  const removeModel = async () => {
    const nextModel = await window.ivritMenuBar.model.remove();
    appState.setModelProgress(null);
    setSettingsState((current) =>
      current
        ? {
            ...current,
            modelState: nextModel
          }
        : current
    );
  };

  const runAudioImport = async (pick: () => Promise<ImportAudioResult>) => {
    try {
      await trackSecondarySourceSelection("imported_file");
      const result = await pick();
      if (!result.canceled && result.transcript) {
        await handleTranscriptReady(result.transcript);
      }
    } catch (error) {
      const message = getHebrewErrorMessage(error, he.importAudioFailed);
      if (message === he.transcriptionCanceled) {
        setErrorMessage(null);
        return;
      }
      setErrorMessage(message);
    }
  };

  const submitYouTubeUrl = async (url: string) => {
    await trackSecondarySourceSelection("youtube");
    await window.ivritMenuBar.youtube.submit({ url });
    setActiveView("workspace");
  };

  const cancelActiveYouTube = async () => {
    const canceled = await window.ivritMenuBar.youtube.cancelActive();
    if (!canceled) {
      return;
    }
    setErrorMessage(null);
  };

  const cancelPendingYouTube = async () => {
    const canceled = await window.ivritMenuBar.youtube.cancelPending();
    if (!canceled) {
      return;
    }
    setErrorMessage(null);
  };

  const revealStorage = async () => {
    if (!appState.storagePaths) {
      return;
    }
    await window.ivritMenuBar.files.revealPath(appState.storagePaths.userDataPath);
  };

  const rerunOnboarding = async () => {
    activationTranscriptIdRef.current = null;
    await mutateOnboarding(() => ({
      onboarding: createDefaultOnboardingState(false)
    }));
    setActiveView("workspace");
  };

  const resetEverything = async () => {
    activationTranscriptIdRef.current = null;
    await removeModel();
    await transcripts.deleteAllTranscripts();
    await updateSetting("dictionary", []);
    await updateSetting("onboardingTracking", createDefaultOnboardingTrackingState());
    await mutateOnboarding(() => ({
      onboarding: createDefaultOnboardingState(false)
    }));
    setActiveView("workspace");
  };

  const trackOnboardingStepViewed = async (step: OnboardingStepKey) => {
    await mutateOnboarding((current) => ({
      events: [
        ...(step === "ready" && current.onboarding.phase === "not_started"
          ? [
              {
                name: "onboarding_started" as const,
                phase: "not_started" as const,
                step: "ready" as const
              }
            ]
          : []),
        {
          name: "onboarding_step_viewed",
          step
        }
      ]
    }));
  };

  const completeOnboardingStep = async (step: OnboardingStepKey) => {
    await mutateOnboarding((current) => ({
      onboarding: step === "ready"
        ? { ...current.onboarding, phase: "needs_mic", surface: "flow" }
        : step === "microphone"
          ? { ...current.onboarding, phase: "needs_hold_key", surface: "flow" }
          : step === "hold_key"
            ? { ...current.onboarding, phase: "needs_model", surface: "flow" }
            : advanceToNextOnboardingPhase(current),
      events: [
        {
          name: "onboarding_step_completed",
          step
        }
      ]
    }));
  };

  const continueOnboardingLater = async (step: OnboardingStepKey) => {
    await mutateOnboarding((current) => ({
      onboarding: {
        ...current.onboarding,
        surface: "workspace"
      },
      events: [
        {
          name: "onboarding_step_exited",
          step
        }
      ]
    }));
    setActiveView("workspace");
  };

  const goBackOnboardingStep = async () => {
    await mutateOnboarding((current) => {
      const phase = current.onboarding.phase;
      const prevPhase =
        phase === "needs_model"
          ? ("needs_hold_key" as const)
          : phase === "needs_hold_key"
            ? ("needs_mic" as const)
            : phase === "needs_mic"
              ? ("not_started" as const)
              : null;
      if (!prevPhase) return null;
      return {
        onboarding: {
          ...current.onboarding,
          phase: prevPhase,
          surface: "flow"
        }
      };
    });
  };

  const resumeOnboardingFlow = async () => {
    await mutateOnboarding((current) => ({
      onboarding: {
        ...current.onboarding,
        surface: "flow"
      }
    }));
    setActiveView("workspace");
  };

  const completeOnboardingOptionalAction = async (action: OnboardingOptionalAction) => {
    await mutateOnboarding((current) => ({
      onboarding: {
        ...current.onboarding,
        completedOptionalActions: current.onboarding.completedOptionalActions.includes(action)
          ? current.onboarding.completedOptionalActions
          : [...current.onboarding.completedOptionalActions, action],
        dismissedOptionalActions: current.onboarding.dismissedOptionalActions.filter((item) => item !== action)
      },
      events: [
        {
          name: "optional_step_completed",
          phase: "activated",
          step: "celebration",
          optionalAction: action
        }
      ]
    }));
  };

  const dismissOnboardingOptionalAction = async (action: OnboardingOptionalAction) => {
    await mutateOnboarding((current) => ({
      onboarding: {
        ...current.onboarding,
        dismissedOptionalActions: current.onboarding.dismissedOptionalActions.includes(action)
          ? current.onboarding.dismissedOptionalActions
          : [...current.onboarding.dismissedOptionalActions, action]
      },
      events: [
        {
          name: "optional_step_dismissed",
          phase: "activated",
          step: "celebration",
          optionalAction: action
        }
      ]
    }));
  };

  const recording = useRecording({
    windowMode: "main",
    timerStartedAt: appState.appState.timerStartedAt,
    microphoneDeviceId: appState.settings?.microphoneDeviceId ?? null,
    permissionStatus: appState.permissionStatus,
    requestPermission: requestMicrophonePermission,
    onStart: async () => {
      const current = settingsRef.current;
      if (!current || current.onboarding.phase === "activated") {
        return;
      }

      await mutateOnboarding((latest) => {
        if (latest.onboarding.phase !== "needs_first_transcript") {
          return null;
        }

        return {
          events: [
            {
              name: "first_transcript_started",
              phase: "needs_first_transcript",
              step: "first_transcript",
              sourceType: "microphone"
            }
          ]
        };
      });
    },
    onTranscript: (transcript) => {
      void handleTranscriptReady(transcript);
    },
    onError: (message) => setErrorMessage(message),
    onDurationLimit: () => setErrorMessage(he.recordingLimitReached)
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
      lastTranscript: transcripts.latestTranscript,
      onboarding,
      onboardingMetrics,
      activeView,
      setActiveView,
      errorMessage,
      setErrorMessage,
      transcripts,
      recording,
      refreshSettings,
      updateSetting,
      setRecordingShortcut,
      setOverlayShortcut,
      requestMicrophonePermission,
      requestAccessibilityPermission,
      downloadModel,
      removeModel,
      importAudio: () => runAudioImport(() => window.ivritMenuBar.files.importAudio()),
      importDroppedAudio: file => runAudioImport(() => window.ivritMenuBar.files.importDroppedAudio(file)),
      submitYouTubeUrl,
      cancelActiveYouTube,
      cancelPendingYouTube,
      revealStorage,
      rerunOnboarding,
      resetEverything,
      trackOnboardingStepViewed,
      completeOnboardingStep,
      continueOnboardingLater,
      goBackOnboardingStep,
      resumeOnboardingFlow,
      completeOnboardingOptionalAction,
      dismissOnboardingOptionalAction
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
      onboardingMetrics,
      recording,
      transcripts
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
