"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { X } from "@/components/icons";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { getRemainingEstimateMs } from "@shared/processing-estimate";
import { CopyButton } from "@/components/CopyButton";
import { RecordButton } from "@/components/RecordButton";
import { Button } from "@/components/ui/button";
import { BarVisualizer, useDocumentVisible, type AgentState } from "@/components/ui/bar-visualizer";
import { useOverlayContext } from "@/context/overlay-context";
import { formatDurationMs } from "@/lib/format";
import { CANCEL_UNDO_WINDOW_MS, isNearRecordingLimit } from "@shared/constants";
import { he } from "@shared/locale";
import type { OverlaySessionErrorCode, OverlaySnapCorner } from "@shared/types";

const IN_APP_HIDE_DELAY_MS = 2500;

function getOverlaySessionErrorMessage(code: OverlaySessionErrorCode | null): string {
  switch (code) {
    case "permission":
      return he.accessibilityPermissionNeeded;
    case "target_unavailable":
      return he.textInsertionTargetUnavailable;
    case "target_changed":
      return he.textInsertionTargetChanged;
    case "secure_field":
      return he.textInsertionSecureField;
    case "clipboard_changed":
      return he.textInsertionClipboardChanged;
    case "clipboard_unavailable":
      return he.textInsertionClipboardUnavailable;
    case "paste_failed":
    default:
      return he.textInsertionFailed;
  }
}

export function FloatingRecorderHud() {
  const {
    loading,
    settings,
    onboarding,
    appState,
    recording,
    permissionStatus,
    accessibilityPermissionStatus,
    requestAccessibilityPermission,
    errorMessage,
    setErrorMessage
  } = useOverlayContext();
  const visible = useDocumentVisible();
  const [now, setNow] = useState(Date.now());
  const [isRetrying, setIsRetrying] = useState(false);
  const [snapCorner, setSnapCorner] = useState<OverlaySnapCorner | null>(null);
  const lastOverlaySessionIdRef = useRef<string | null>(null);
  const overlaySession = appState.overlaySession ?? null;
  const setupComplete = onboarding?.phase === "needs_first_transcript" || onboarding?.phase === "activated";
  const microphoneBlocked = permissionStatus === "denied" || permissionStatus === "restricted";
  const undoAvailable = recording.heldRecording?.reason === "canceled";

  useEffect(() => {
    const needsTicker = visible && (
      appState.status === "recording" ||
      (appState.status === "processing" && appState.activeSourceType === "microphone" && Boolean(appState.processingStartedAt))
    );

    if (!needsTicker) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible, appState.activeSourceType, appState.processingStartedAt, appState.status]);

  useEffect(() => {
    const nextSessionId = overlaySession?.id ?? null;
    if (lastOverlaySessionIdRef.current === nextSessionId) {
      return;
    }

    lastOverlaySessionIdRef.current = nextSessionId;
    setIsRetrying(false);
    setErrorMessage(null);
  }, [overlaySession?.id, setErrorMessage]);

  // The text in the field is the feedback. Only a problem earns a message here.
  const pasted = overlaySession?.phase === "success" && !overlaySession.deliveredInApp && !errorMessage;

  useEffect(() => {
    const successText = overlaySession?.phase === "success" ? overlaySession.transcriptText : null;

    if (!successText || errorMessage) {
      return;
    }

    const timer = window.setTimeout(() => {
      setErrorMessage(null);
      void window.ivritMenuBar.overlay.hide();
    }, pasted ? 0 : IN_APP_HIDE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [errorMessage, overlaySession?.phase, overlaySession?.transcriptText, pasted, setErrorMessage]);

  const dismissable = !overlaySession || undoAvailable || overlaySession.phase === "paste_failed" || overlaySession.phase === "success" || Boolean(errorMessage);

  const handleStart = useEffectEvent(async () => {
    if (!settings || recording.isPreparing || appState.status === "processing" || appState.status === "youtube_downloading") {
      return;
    }

    // Dictating here is itself a way to finish setup, so only the steps before it block.
    if (!setupComplete) {
      setErrorMessage(he.overlaySetupRequired);
      return;
    }

    if (settings.modelState.downloadState !== "ready") {
      setErrorMessage(he.modelMissing);
      return;
    }

    setIsRetrying(false);
    setErrorMessage(null);
    await recording.startRecording();
  });

  const handleStop = useEffectEvent(async () => {
    setErrorMessage(null);
    await recording.stopRecording();
  });

  const cancelRecordingAndHide = useEffectEvent(async () => {
    try {
      const kept = await recording.cancelRecording();
      setErrorMessage(null);
      // A recording worth undoing keeps the window open; the undo timer closes it.
      if (!kept) await window.ivritMenuBar.overlay.hide();
    } catch (error) { setErrorMessage(getHebrewErrorMessage(error, he.stopRecordingFailed)); }
  });

  const handleDismiss = useEffectEvent(async () => {
    setIsRetrying(false);
    setErrorMessage(null);
    recording.dropHeldRecording();
    await window.ivritMenuBar.overlay.hide();
  });

  const handleResend = useEffectEvent(async () => {
    setErrorMessage(null);
    await recording.resendHeldRecording();
  });

  const openMainWindow = useEffectEvent(async () => {
    setErrorMessage(null);
    await window.ivritMenuBar.app.showMain(setupComplete && microphoneBlocked ? "settings" : "workspace");
    await window.ivritMenuBar.overlay.hide();
  });

  const cancelProcessing = useEffectEvent(async () => {
    setIsRetrying(false);
    setErrorMessage(null);
    const { canceled, held } = await recording.cancelProcessing();
    // Held audio waits for Undo; a paste already under way reports its own result.
    if (canceled && !held) await window.ivritMenuBar.overlay.hide();
  });

  const handleRetryPaste = useEffectEvent(async () => {
    const transcriptText = overlaySession?.transcriptText?.trim();
    if (!transcriptText) {
      return;
    }

    setIsRetrying(true);
    try {
      // Main moves the session on, and with it what this window may claim.
      await window.ivritMenuBar.textInsert.intoFocusedField(transcriptText);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getHebrewErrorMessage(error, he.textInsertionFailed));
    } finally {
      setIsRetrying(false);
    }
  });

  const handlePasteRecoveryPrimaryAction = useEffectEvent(async () => {
    if (overlaySession?.lastErrorCode === "permission" && accessibilityPermissionStatus !== "granted") {
      await requestAccessibilityPermission();
      return;
    }

    await handleRetryPaste();
  });

  const handleShortcutToggle = useEffectEvent(async () => {
    // A double press must never throw finished speech away.
    if (appState.status === "processing" && appState.activeSourceType === "microphone") return;

    if (recording.isPreparing) {
      try {
        if (!await recording.abandonStart()) await window.ivritMenuBar.overlay.hide();
      } catch (error) { setErrorMessage(getHebrewErrorMessage(error, he.stopRecordingFailed)); }
      return;
    }

    if (appState.status === "recording" || appState.status === "paused") {
      await handleStop();
      return;
    }

    if (recording.heldRecording?.reason === "failed") {
      await handleResend();
      return;
    }

    await handleStart();
  });

  const handleHoldPress = useEffectEvent(() => {
    const { status } = appState;
    if (status === "processing" || status === "youtube_downloading" || recording.isPreparing) return;
    if (status === "recording" || status === "paused") return;

    if (recording.heldRecording?.reason === "failed") {
      void handleResend();
      return;
    }

    if (!settings) return;
    if (!setupComplete) {
      setErrorMessage(he.overlaySetupRequired);
      return;
    }

    if (settings.modelState.downloadState !== "ready") {
      setErrorMessage(he.modelMissing);
      return;
    }

    setIsRetrying(false);
    setErrorMessage(null);
    recording.beginHold();
  });

  useEffect(() => {
    const unsubscribeToggle = window.ivritMenuBar.app.onRecordingToggleRequested(() => {
      void handleShortcutToggle();
    });
    const unsubscribeHold = window.ivritMenuBar.app.onRecordingHoldRequested((phase) => {
      if (phase === "press") handleHoldPress();
      else recording.endHold();
    });

    if (!loading && settings) void window.ivritMenuBar.overlay.ready();
    return () => {
      unsubscribeToggle();
      unsubscribeHold();
    };
  }, [handleHoldPress, handleShortcutToggle, loading, recording, settings]);

  useEffect(() => {
    if (!undoAvailable) return;
    const timer = window.setTimeout(() => void handleDismiss(), CANCEL_UNDO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [handleDismiss, undoAvailable]);

  // The HUD rarely has keyboard focus while dictating, so main forwards Esc as a global key.
  useEffect(() => window.ivritMenuBar.app.onRecordingCancelRequested(() => {
    void (appState.status === "processing" ? cancelProcessing() : cancelRecordingAndHide());
  }), [appState.status, cancelProcessing, cancelRecordingAndHide]);

  useEffect(() => window.ivritMenuBar.app.onRecordingUndoRequested(() => {
    if (undoAvailable) void handleResend();
  }), [handleResend, undoAvailable]);

  useEffect(() => window.ivritMenuBar.app.onRecordingInterruptRequested(() => {
    void recording.interruptRecording(he.recordingInterrupted);
  }), [recording]);

  // The overlay shortcut gives this window keyboard focus: Enter then takes the main way out.
  useEffect(() => {
    const focusPrimary = () => document.querySelector<HTMLElement>("[data-hud-primary]")?.focus();
    focusPrimary();
    window.addEventListener("focus", focusPrimary);
    return () => window.removeEventListener("focus", focusPrimary);
  }, [overlaySession?.phase, overlaySession?.lastErrorCode, recording.heldRecording?.reason]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();

      if (appState.status === "recording" || appState.status === "paused") {
        void cancelRecordingAndHide();
        return;
      }

      if (appState.status === "processing" && appState.activeSourceType === "microphone") {
        void cancelProcessing();
        return;
      }

      if (dismissable) {
        void handleDismiss();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appState.activeSourceType, appState.status, cancelProcessing, cancelRecordingAndHide, dismissable, handleDismiss]);

  useEffect(() => {
    return window.ivritMenuBar.overlay.onSnapPreview((corner) => {
      setSnapCorner(corner);
    });
  }, []);

  const successText = overlaySession?.phase === "success" ? overlaySession.transcriptText : null;
  const pasteRecoveryMessage = overlaySession?.phase === "paste_failed"
    ? overlaySession.manualCopyOnly && overlaySession.insertionOutcome !== "not_dispatched"
      ? "התמלול נשמר, אבל לא ברור אם הגיע לשדה. כדאי לבדוק לפני הדבקה ידנית, כדי לא להכפיל."
      : overlaySession.manualCopyOnly && (!overlaySession.lastErrorCode || overlaySession.lastErrorCode === "paste_failed")
        ? "התמלול נשמר, אבל לא נשלח לשדה. אפשר להעתיק אותו ולהדביק ידנית."
        : getOverlaySessionErrorMessage(overlaySession.lastErrorCode)
    : null;
  const resolvedErrorMessage = successText ? null : (errorMessage ?? pasteRecoveryMessage);
  const hasPasteRecovery = overlaySession?.phase === "paste_failed" && Boolean(overlaySession.transcriptText);
  const preview = (appState.status === "recording" || appState.status === "paused" || appState.status === "processing") ? recording.livePreview : null;
  // The runtime reports recording before the microphone opens; only an open one may look live.
  const capturing = (appState.status === "recording" || appState.status === "paused") && !recording.isPreparing && !recording.isResending;
  const elapsed = appState.status === "recording" ? Math.max(0, now - (appState.timerStartedAt ?? now)) : appState.timerStartedAt ?? 0;
  const nearLimit = capturing && isNearRecordingLimit(elapsed);
  const expanded = Boolean(resolvedErrorMessage || hasPasteRecovery || preview?.text || nearLimit);
  useLayoutEffect(() => { void window.ivritMenuBar.overlay.setSize(expanded ? "expanded" : "compact"); }, [expanded]);

  if (loading || !settings) {
    return <main className="overlay-root"><p className="hud-loading">{he.loadingApp}</p></main>;
  }
  if (pasted) return <main className="overlay-root" />;

  const processingMicrophone = (appState.status === "processing" && appState.activeSourceType === "microphone") || recording.isResending;
  const busy = appState.status === "processing" || appState.status === "youtube_downloading";
  const primaryRecoveryLabel =
    overlaySession?.lastErrorCode === "permission" && accessibilityPermissionStatus !== "granted"
      ? he.allowAccessibility
      : overlaySession?.lastErrorCode === "target_changed"
        ? he.pasteIntoApp(overlaySession.targetAppName)
        : he.retry;

  const visualizerState: AgentState = appState.status === "recording" ? "speaking" : appState.status === "paused" ? "listening" : "idle";
  const modelReady = settings.modelState.downloadState === "ready";
  const remainingProcessingMs = processingMicrophone
    ? getRemainingEstimateMs({
        processingStartedAt: appState.processingStartedAt,
        processingEstimateMs: appState.processingEstimateMs,
        now
      })
    : null;
  // Below ten seconds a countdown adds stress, not information.
  const processingEtaValue = remainingProcessingMs !== null && remainingProcessingMs >= 10_000 ? formatDurationMs(remainingProcessingMs) : null;
  const captionText = successText
    ? he.transcriptReadyInApp
    : undoAvailable
      ? he.recordingCanceled
    : recording.heldRecording
      ? he.recordingHeld
    : hasPasteRecovery
      ? "התמלול מוכן"
    : processingMicrophone
      ? processingEtaValue
        ? `${he.visualizerThinking} · כ־${processingEtaValue}`
        : he.visualizerThinking
    : appState.status === "youtube_downloading"
      ? he.visualizerDownloading
    : appState.status === "processing"
      ? he.youtubeTranscribing
    : recording.isPreparing
      ? "פותחים את המיקרופון…"
      : setupComplete && modelReady ? "מוכנים להכתבה" : he.overlayNotReady;
  const liveCaptionText = resolvedErrorMessage
    ? resolvedErrorMessage
    : successText
      ? he.transcriptReadyInApp
      : undoAvailable
        ? he.recordingCanceled
      : processingMicrophone
        ? he.workspaceProcessingHint
        : nearLimit
          ? he.recordingLimitSoon
          : appState.status === "paused"
            ? he.workspacePausedHint
            : appState.status === "recording"
              ? recording.isPreparing ? null : he.workspaceRecordingHint
              : !modelReady
                ? he.workspaceConnectingHint
                : null;
  const accessibilityError = resolvedErrorMessage === he.accessibilityPermissionNeeded;
  // Setup, the model and a refused microphone can only be fixed outside this small window.
  const fixedInMainWindow = !setupComplete || !modelReady || microphoneBlocked;
  const canResend = recording.heldRecording?.reason === "failed";
  const errorLabel = accessibilityError ? he.allowAccessibility : fixedInMainWindow ? he.openMainWindow : permissionStatus !== "granted" ? he.allowMicrophone : he.retry;
  const errorAction = accessibilityError ? requestAccessibilityPermission : fixedInMainWindow ? openMainWindow : handleStart;

  return <main className="overlay-root">
    <section role="dialog" aria-label={he.transcription} className="recorder-hud app-drag" data-size={expanded ? "expanded" : "compact"}>
      {snapCorner && <div className="hud-snap" aria-hidden="true" />}
      <p className="sr-only" role={resolvedErrorMessage ? "alert" : "status"} aria-live={resolvedErrorMessage ? "assertive" : "polite"} aria-atomic="true">{liveCaptionText}</p>
      <div className="hud-row">
        {successText ? <div className="capsule app-no-drag"><CopyButton text={successText} emphasized /></div>
        : undoAvailable || canResend ? <div className="capsule app-no-drag">
          <Button type="button" variant="plain" className="hud-undo" data-hud-primary="" aria-keyshortcuts={canResend ? undefined : "Meta+Z"} onClick={() => void handleResend()}>{canResend ? he.retryTranscription : he.undoWithShortcut}</Button>
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>
        </div>
        : capturing ? <div className="capsule app-no-drag">
          <RecordButton mode="stop" onClick={() => void handleStop()} />
          <RecordButton mode={appState.status === "paused" ? "resume" : "pause"}
            onClick={() => void (appState.status === "paused" ? recording.resumeRecording() : recording.pauseRecording())} />
          <Button type="button" variant="plain" className="capsule-round" aria-label="ביטול ההקלטה" title="ביטול ההקלטה (Esc)" onClick={() => void cancelRecordingAndHide()}><X /></Button>
        </div>
        : processingMicrophone ? <div className="capsule app-no-drag" data-quiet="true"><RecordButton mode="cancel" onClick={() => void cancelProcessing()} /></div>
        : !hasPasteRecovery && <div className="capsule app-no-drag" data-quiet={busy || settings.modelState.downloadState !== "ready"}>
          <RecordButton mode="start" disabled={recording.isPreparing || busy} onClick={() => void handleStart()} />
          {recording.isPreparing
            ? <Button type="button" variant="plain" className="capsule-round" aria-label="ביטול ההקלטה" title="ביטול ההקלטה (Esc)" onClick={() => void cancelRecordingAndHide()}><X /></Button>
            : <Button type="button" variant="plain" className="capsule-round" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>}
        </div>}
        {capturing ? <>
          <BarVisualizer state={visualizerState} mediaStream={recording.mediaStream} barCount={13} minHeight={10} maxHeight={100} aria-hidden="true" />
          <span className="hud-time" dir="ltr" aria-hidden="true">{formatDurationMs(elapsed)}</span>
        </> : <p className="hud-caption" title={captionText}>{captionText}</p>}
        {hasPasteRecovery && <Button type="button" variant="ghost" size="icon-sm" className="app-no-drag" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>}
      </div>
      {expanded && <div className="hud-body">
        {resolvedErrorMessage ? <>
          <p className="hud-message" data-tone="alert" title={resolvedErrorMessage}>{resolvedErrorMessage}</p>
          <div className="hud-actions app-no-drag">
            {hasPasteRecovery ? <>
              <CopyButton text={overlaySession?.transcriptText ?? ""} emphasized />
              {!overlaySession?.manualCopyOnly && <Button size="sm" variant="secondary" data-hud-primary="" disabled={isRetrying} onClick={() => void handlePasteRecoveryPrimaryAction()}>{primaryRecoveryLabel}</Button>}
            </> : !canResend && <Button size="sm" variant="secondary" onClick={() => void errorAction()}>{errorLabel}</Button>}
          </div>
        </> : nearLimit ? <p className="hud-message">{he.recordingLimitSoon}</p>
        : preview && <p className="hud-preview" dir="auto" title={preview.text}>
          <span>{preview.stableText}</span>{" "}
          <span className="hud-preview-pending">{preview.text.startsWith(preview.stableText) ? preview.text.slice(preview.stableText.length) : preview.text}</span>
        </p>}
      </div>}
    </section>
  </main>;
}
