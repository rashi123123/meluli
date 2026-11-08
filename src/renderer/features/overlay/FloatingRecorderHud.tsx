import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CaretDown, X } from "@/components/icons";
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
import { failureCopy } from "@/features/flows/flow-copy";
import "@/features/flows/flows.css";
import { isMicrophoneBlocked } from "@/lib/microphone-permission";
import { playCue } from "@/lib/sounds";

const IN_APP_HIDE_DELAY_MS = 2500;
/** Long enough to reach "back to the original" after looking at the pasted result. */
const FLOW_NOTICE_MS = 6000;
const FLOW_COPY_MS = 15_000;
const ERROR_HIDE_DELAY_MS = 5000;
const BUSY_NOTICE_MS = 3000;

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reverting, setReverting] = useState(false);
  // A hold pressed while the last dictation is still being written records nothing; this says so.
  const [busyNotice, setBusyNotice] = useState(false);
  const busyTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (busyTimerRef.current !== null) window.clearTimeout(busyTimerRef.current); }, []);
  const lastOverlaySessionIdRef = useRef<string | null>(null);
  const overlaySession = appState.overlaySession ?? null;
  const setupComplete = onboarding?.phase === "needs_first_transcript" || onboarding?.phase === "activated";
  const microphoneBlocked = isMicrophoneBlocked(permissionStatus);
  const undoAvailable = recording.heldRecording?.reason === "canceled";
  const flowStatus = overlaySession?.flowStatus;
  const flowChoices = overlaySession?.flowChoices ?? [];
  const sessionFlow = overlaySession?.flowId ? settings?.flows.find((flow) => flow.id === overlaySession.flowId) : undefined;
  const flowName = sessionFlow?.name ?? flowChoices.find((choice) => choice.id === overlaySession?.flowId)?.name ?? he.hudFlowFallback;
  // After a paste the HUD stays only to offer the original back, or to say the flow did not run.
  const flowNotice = overlaySession?.phase === "success" && !overlaySession.deliveredInApp
    ? flowStatus === "applied" && sessionFlow?.delivery === "paste" ? "revert"
      : flowStatus === "failed" ? "failed"
      : flowStatus === "copy_raw" ? "copy_raw" : null
    : null;
  const flowPreview = flowStatus === "preview" && appState.status === "processing";

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
    setPickerOpen(false);
    setReverting(false);
    setErrorMessage(null);
  }, [overlaySession?.id, setErrorMessage]);

  // The text in the field is the feedback. Only a problem earns a message here.
  const pasted = overlaySession?.phase === "success" && !overlaySession.deliveredInApp && !errorMessage && !flowNotice;

  useEffect(() => {
    const successText = overlaySession?.phase === "success" ? overlaySession.transcriptText : null;

    if (!successText || errorMessage) {
      return;
    }

    const timer = window.setTimeout(() => {
      setErrorMessage(null);
      void window.ivritMenuBar.overlay.hide();
    }, pasted ? 0 : flowNotice === "copy_raw" ? FLOW_COPY_MS : flowNotice ? FLOW_NOTICE_MS : IN_APP_HIDE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [errorMessage, flowNotice, overlaySession?.phase, overlaySession?.transcriptText, pasted, setErrorMessage]);

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

  const chooseFlow = useEffectEvent(async (flowId: string | null) => {
    setPickerOpen(false);
    await window.ivritMenuBar.flows.choose(flowId);
  });

  const choosePreview = useEffectEvent(async (choice: "result" | "original") => {
    try { await window.ivritMenuBar.flows.preview(choice); }
    catch (error) { setErrorMessage(getHebrewErrorMessage(error, he.textInsertionFailed)); }
  });

  const revertFlow = useEffectEvent(async () => {
    setReverting(true);
    try { await window.ivritMenuBar.flows.revert(); }
    catch (error) { setErrorMessage(getHebrewErrorMessage(error, he.textInsertionFailed)); }
    finally { setReverting(false); }
  });

  const openFlows = useEffectEvent(async () => {
    await window.ivritMenuBar.app.showMain("flows");
    await window.ivritMenuBar.overlay.hide();
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
    // The last dictation is still being written. Nothing records, and the window says so at once.
    if (status === "processing" && appState.activeSourceType === "microphone") {
      setBusyNotice(true);
      if (busyTimerRef.current !== null) window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = window.setTimeout(() => { busyTimerRef.current = null; setBusyNotice(false); }, BUSY_NOTICE_MS);
      void playCue("busy").catch(() => undefined);
      return;
    }
    if (status === "processing" || status === "youtube_downloading" || recording.isPreparing) return;
    if (status === "recording" || status === "paused") return;

    // A hold is for new speech. Failed audio already in history waits there; audio kept only
    // here is sent again instead, so it is never dropped.
    if (recording.heldRecording?.reason === "failed" && !recording.heldRecordingSaved()) {
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
  }, [loading, recording, settings]);

  useEffect(() => {
    if (!undoAvailable) return;
    const timer = window.setTimeout(() => void handleDismiss(), CANCEL_UNDO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [undoAvailable]);

  // The HUD rarely has keyboard focus while dictating, so main forwards Esc as a global key.
  useEffect(() => window.ivritMenuBar.app.onRecordingCancelRequested(() => {
    void (appState.status === "processing" ? cancelProcessing() : cancelRecordingAndHide());
  }), [appState.status]);

  useEffect(() => window.ivritMenuBar.app.onRecordingUndoRequested(() => {
    if (undoAvailable) void handleResend();
  }), [undoAvailable]);

  useEffect(() => window.ivritMenuBar.app.onRecordingInterruptRequested(() => {
    void recording.interruptRecording(he.recordingInterrupted);
  }), [recording]);

  // The overlay shortcut gives this window keyboard focus: Enter then takes the main way out.
  useEffect(() => {
    const focusPrimary = () => document.querySelector<HTMLElement>("[data-hud-primary]")?.focus();
    focusPrimary();
    window.addEventListener("focus", focusPrimary);
    return () => window.removeEventListener("focus", focusPrimary);
  }, [overlaySession?.phase, overlaySession?.lastErrorCode, overlaySession?.flowStatus, recording.heldRecording?.reason]);

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
  }, [appState.activeSourceType, appState.status, dismissable]);

  useEffect(() => {
    return window.ivritMenuBar.overlay.onSnapPreview((corner) => {
      setSnapCorner(corner);
    });
  }, []);

  const successText = overlaySession?.phase === "success" ? overlaySession.transcriptText : null;
  const pasteRecoveryMessage = overlaySession?.phase === "paste_failed"
    ? overlaySession.manualCopyOnly && overlaySession.insertionOutcome !== "not_dispatched"
      ? he.hudPasteUnsure
      : overlaySession.manualCopyOnly && (!overlaySession.lastErrorCode || overlaySession.lastErrorCode === "paste_failed")
        ? he.hudPasteNotSent
        : getOverlaySessionErrorMessage(overlaySession.lastErrorCode)
    : null;
  const resolvedErrorMessage = successText ? null : (errorMessage ?? pasteRecoveryMessage);
  const hasPasteRecovery = overlaySession?.phase === "paste_failed" && Boolean(overlaySession.transcriptText);
  const preview = (appState.status === "recording" || appState.status === "paused" || appState.status === "processing") ? recording.livePreview : null;
  // The runtime reports recording before the microphone opens; only an open one may look live.
  const capturing = (appState.status === "recording" || appState.status === "paused") && !recording.isPreparing && !recording.isResending;
  const elapsed = appState.status === "recording" ? Math.max(0, now - (appState.timerStartedAt ?? now)) : appState.timerStartedAt ?? 0;
  const nearLimit = capturing && isNearRecordingLimit(elapsed);
  const showPicker = pickerOpen && capturing && flowChoices.length > 0;
  const flowFailureMessage = flowNotice === "failed" ? he.hudFlowFailed(flowName, failureCopy(overlaySession?.flowFailure ?? null)) : null;
  const flowSettingsFix = overlaySession?.flowFailure === "not_ready" || overlaySession?.flowFailure === "auth" || overlaySession?.flowFailure === "model";
  const expanded = Boolean(resolvedErrorMessage || hasPasteRecovery || preview?.text || nearLimit || showPicker || flowPreview || flowNotice === "failed" || flowNotice === "copy_raw");
  useLayoutEffect(() => { void window.ivritMenuBar.overlay.setSize(expanded ? "expanded" : "compact"); }, [expanded]);

  // A plain error has said what it needs to after a few seconds. Text that is still owed somewhere,
  // and problems only the main window can fix, stay up. A pointer over the window holds it open.
  const [hovering, setHovering] = useState(false);
  const idle = appState.status !== "recording" && appState.status !== "paused" && appState.status !== "processing" && appState.status !== "youtube_downloading";
  const plainError = Boolean(errorMessage) && idle && !recording.isPreparing && !hasPasteRecovery && !recording.heldRecording && !flowNotice
    && errorMessage !== he.accessibilityPermissionNeeded && setupComplete && !microphoneBlocked && settings?.modelState.downloadState === "ready";
  useEffect(() => {
    if (!plainError || hovering) return;
    const timer = window.setTimeout(() => void handleDismiss(), ERROR_HIDE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [plainError, hovering, errorMessage]);

  if (loading || !settings) {
    return <main className="overlay-root"><p className="hud-loading">{he.loadingApp}</p></main>;
  }
  if (pasted) return <main className="overlay-root" />;

  const processingMicrophone = (appState.status === "processing" && appState.activeSourceType === "microphone") || recording.isResending;
  const busy = appState.status === "processing" || appState.status === "youtube_downloading";
  // A secure field or a closed app cannot take a retry, so Copy leads there; otherwise the retry does.
  const copyLeads = Boolean(overlaySession?.manualCopyOnly) || overlaySession?.lastErrorCode === "secure_field" || overlaySession?.lastErrorCode === "target_unavailable";
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
  const captionText = flowNotice === "revert" || flowPreview
    ? flowName
    : flowNotice === "failed"
      ? he.hudOriginalPasted
    : flowNotice === "copy_raw"
      ? he.hudOriginalReady
    : successText
    ? he.transcriptReadyInApp
    : undoAvailable
      ? he.recordingCanceled
    : recording.heldRecording
      ? he.recordingHeld
    : hasPasteRecovery
      ? he.hudTranscriptReady
    : processingMicrophone && busyNotice
      ? he.holdWhileWriting
    : processingMicrophone && flowStatus === "running"
      ? he.hudFlowRunning(flowName)
    : processingMicrophone
      ? processingEtaValue
        ? `${he.visualizerThinking} · כ־${processingEtaValue}`
        : he.visualizerThinking
    : appState.status === "youtube_downloading"
      ? he.visualizerDownloading
    : appState.status === "processing"
      ? he.youtubeTranscribing
    : recording.isPreparing
      ? he.hudOpeningMicrophone
    : !setupComplete
      ? he.hudSetupFirst
    : microphoneBlocked
      ? he.microphoneBlockedTitle
    : !modelReady
      ? settings.modelState.downloadState === "downloading" ? he.hudModelDownloading : he.hudModelMissing
      : he.hudReady;
  const liveCaptionText = resolvedErrorMessage
    ? resolvedErrorMessage
    : flowPreview
      ? he.hudPreviewReady
    : flowFailureMessage
      ? `${flowFailureMessage} ${he.hudOriginalPasted}.`
    : flowNotice === "copy_raw"
      ? he.hudOriginalCopyHint
    : successText
      ? he.transcriptReadyInApp
      : undoAvailable
        ? he.recordingCanceled
      : processingMicrophone && busyNotice
        ? he.holdWhileWritingHint
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
  const errorLabel = accessibilityError ? he.allowAccessibility : fixedInMainWindow ? setupComplete && microphoneBlocked ? he.hudOpenSettings : he.openMainWindow : permissionStatus !== "granted" ? he.allowMicrophone : he.retry;
  const errorAction = accessibilityError ? requestAccessibilityPermission : fixedInMainWindow ? openMainWindow : handleStart;

  return <main className="overlay-root">
    <section role="dialog" aria-label={he.transcription} className="recorder-hud app-drag" data-size={expanded ? "expanded" : "compact"}
      onPointerEnter={() => setHovering(true)} onPointerLeave={() => setHovering(false)}>
      {snapCorner && <div className="hud-snap" aria-hidden="true" />}
      {/* Both regions stay mounted: a region that changes role, or appears with its text, is often not read. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{resolvedErrorMessage ? null : liveCaptionText}</p>
      <p className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{resolvedErrorMessage}</p>
      <div className="hud-row">
        {flowNotice === "revert" ? <div className="capsule app-no-drag">
          <Button type="button" variant="plain" className="hud-undo" data-hud-primary="" disabled={reverting} onClick={() => void revertFlow()}>{he.hudRevert}</Button>
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>
        </div>
        : flowNotice === "failed" || flowNotice === "copy_raw" ? <div className="capsule app-no-drag">
          {flowNotice === "copy_raw" && <CopyButton text={overlaySession?.transcriptText ?? ""} emphasized />}
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>
        </div>
        : flowPreview ? <div className="capsule app-no-drag">
          <Button type="button" variant="plain" className="hud-undo" data-hud-primary="" onClick={() => void choosePreview("result")}>{he.hudPasteResult}</Button>
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.hudPasteOriginal} title={`${he.hudPasteOriginal} (Esc)`} onClick={() => void choosePreview("original")}><X /></Button>
        </div>
        : successText ? <div className="capsule app-no-drag"><CopyButton text={successText} emphasized /></div>
        : undoAvailable || canResend ? <div className="capsule app-no-drag">
          <Button type="button" variant="plain" className="hud-undo" data-hud-primary="" aria-keyshortcuts={canResend ? undefined : "Meta+Z"} onClick={() => void handleResend()}>{canResend ? he.retryTranscription : he.undoWithShortcut}</Button>
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>
        </div>
        : capturing ? <div className="capsule app-no-drag">
          <RecordButton mode="stop" onClick={() => void handleStop()} />
          <RecordButton mode={appState.status === "paused" ? "resume" : "pause"}
            onClick={() => void (appState.status === "paused" ? recording.resumeRecording() : recording.pauseRecording())} />
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.hudCancelRecording} title={`${he.hudCancelRecording} (Esc)`} onClick={() => void cancelRecordingAndHide()}><X /></Button>
        </div>
        : processingMicrophone ? <div className="capsule app-no-drag" data-quiet="true"><RecordButton mode="cancel" onClick={() => void cancelProcessing()} /></div>
        // The paste failed but the text is safe: the actions sit below, so the capsule only closes, like every other state's close.
        : hasPasteRecovery ? <div className="capsule app-no-drag" data-quiet="true">
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>
        </div>
        : <div className="capsule app-no-drag" data-quiet={busy || settings.modelState.downloadState !== "ready"}>
          <RecordButton mode="start" disabled={recording.isPreparing || busy} onClick={() => void handleStart()} />
          {recording.isPreparing
            ? <Button type="button" variant="plain" className="capsule-round" aria-label={he.hudCancelRecording} title={`${he.hudCancelRecording} (Esc)`} onClick={() => void cancelRecordingAndHide()}><X /></Button>
            : <Button type="button" variant="plain" className="capsule-round" aria-label={he.close} title={he.close} onClick={() => void handleDismiss()}><X /></Button>}
        </div>}
        {capturing ? <>
          {/* Paused bars look like silence, so the pause is said in words. */}
          {appState.status === "paused"
            ? <p className="hud-caption">{he.hudPaused}</p>
            : <BarVisualizer state={visualizerState} mediaStream={recording.mediaStream} barCount={13} minHeight={10} maxHeight={100} aria-hidden="true" />}
          {/* The flow pill takes the timer's place: the window has room for one of them. */}
          {flowChoices.length > 0
            ? <button type="button" className="flow-hud-pill app-no-drag" data-off={overlaySession?.flowId ? undefined : ""} aria-expanded={showPicker} aria-haspopup="listbox"
              aria-label={he.hudFlowLabel(overlaySession?.flowId ? flowName : he.hudNoFlow)} onClick={() => setPickerOpen((open) => !open)}>
              <span>{overlaySession?.flowId ? flowName : he.hudNoFlow}</span><CaretDown /></button>
            : <span className="hud-time" dir="ltr" aria-hidden="true">{formatDurationMs(elapsed)}</span>}
        </> : <>
          {/* Work without a signal: still bars with light passing along them. */}
          {processingMicrophone && <BarVisualizer className="hud-thinking" state="thinking" barCount={7} aria-hidden="true" />}
          <p className="hud-caption" title={captionText}>{captionText}</p>
        </>}
      </div>
      {expanded && <div className="hud-body">
        {showPicker ? <FlowPicker
          choices={[...flowChoices.map(({ id, name }) => ({ id, name })), { id: null, name: he.hudNoFlow }]}
          selectedId={overlaySession?.flowId ?? null}
          onChoose={(id) => void chooseFlow(id)}
          onClose={() => setPickerOpen(false)} />
        : flowPreview ? <>
          <p className="flow-hud-result" dir="auto" title={overlaySession?.transcriptText ?? ""}>{overlaySession?.transcriptText}</p>
          <p className="flow-hud-keys"><span>{he.hudPreviewKeyPaste}</span><span><kbd>Esc</kbd> {he.hudPreviewKeyOriginal}</span></p>
        </>
        : flowFailureMessage ? <>
          <p className="hud-message" data-tone="alert" title={flowFailureMessage}>{flowFailureMessage}</p>
          {flowSettingsFix && <div className="hud-actions app-no-drag"><Button size="sm" variant="secondary" onClick={() => void openFlows()}>{he.hudOpenFlows}</Button></div>}
        </>
        : flowNotice === "copy_raw" ? <p className="hud-message">{he.hudOriginalCopyHint}</p>
        : resolvedErrorMessage ? <>
          <p className="hud-message" data-tone="alert" title={resolvedErrorMessage}>{resolvedErrorMessage}</p>
          <div className="hud-actions app-no-drag">
            {hasPasteRecovery ? <>
              <CopyButton text={overlaySession?.transcriptText ?? ""} emphasized={copyLeads} primary={copyLeads} />
              {!overlaySession?.manualCopyOnly && <Button size="sm" variant={copyLeads ? "secondary" : "default"} data-hud-primary={copyLeads ? undefined : ""} disabled={isRetrying} onClick={() => void handlePasteRecoveryPrimaryAction()}>{primaryRecoveryLabel}</Button>}
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

type FlowChoice = { id: string | null; name: string };

/** A listbox the keyboard can walk: arrows move, Enter chooses, Esc closes without choosing. */
function FlowPicker({ choices, selectedId, onChoose, onClose }: { choices: FlowChoice[]; selectedId: string | null; onChoose: (id: string | null) => void; onClose: () => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const options = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const index = options.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(index + step + options.length) % options.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      options[event.key === "Home" ? 0 : options.length - 1]?.focus();
    } else if (event.key === "Escape") {
      // Closing the list must not also cancel the recording underneath it.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      onClose();
    }
  };

  return <ul ref={listRef} className="flow-hud-list app-no-drag" role="listbox" aria-label={he.hudFlowListLabel} onKeyDown={onKeyDown}>
    {choices.map((choice) =>
      <li key={choice.id ?? "none"} role="none"><button type="button" role="option" aria-selected={selectedId === choice.id}
        tabIndex={selectedId === choice.id ? 0 : -1}
        data-off={choice.id ? undefined : ""} title={choice.name} onClick={() => onChoose(choice.id)}>{choice.name}</button></li>)}
  </ul>;
}
