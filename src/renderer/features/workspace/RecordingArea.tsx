import { useEffect, useRef, useState } from "react";
import { CaretDown, FloatingWindow, X } from "@/components/icons";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { getRemainingEstimateMs } from "@shared/processing-estimate";
import { RecordButton } from "@/components/RecordButton";
import { BarVisualizer, type AgentState } from "@/components/ui/bar-visualizer";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { useMicrophoneDevices } from "@/hooks/use-microphone-devices";
import { formatDurationMs } from "@/lib/format";
import { formatShortcut, toAriaKeyShortcuts } from "@/lib/shortcut";
import { isNearRecordingLimit } from "@shared/constants";
import { he } from "@shared/locale";
import { FileDropCell } from "./FileDropCell";
import { YouTubeInputRow } from "./YouTubeInputRow";
import { isMicrophoneBlocked } from "@/lib/microphone-permission";

export function RecordingArea() {
  const { appState, recording, settings, permissionStatus, importAudio, importDroppedAudio, cancelActiveYouTube, setErrorMessage, updateSetting } = useAppContext();
  const [now, setNow] = useState(Date.now());
  const primaryAction = useRef<HTMLButtonElement>(null);
  const { devices, selectedLabel } = useMicrophoneDevices(settings?.microphoneDeviceId, permissionStatus);
  const capturing = appState.status === "recording" || appState.status === "paused";
  const processing = appState.status === "processing" || appState.status === "youtube_downloading";
  const youtubeWork = appState.status === "youtube_downloading" || (appState.status === "processing" && appState.activeSourceType === "youtube");
  useEffect(() => {
    if (appState.status !== "recording" && appState.status !== "processing") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [appState.status, appState.timerStartedAt, appState.processingStartedAt]);

  const elapsed = appState.status === "recording" && appState.timerStartedAt
    ? Math.max(0, now - appState.timerStartedAt)
    : appState.status === "paused" ? appState.timerStartedAt ?? 0 : 0;
  const remaining = appState.status === "processing" && appState.activeSourceType === "microphone"
    ? getRemainingEstimateMs({ processingStartedAt: appState.processingStartedAt, processingEstimateMs: appState.processingEstimateMs, now }) : null;
  const modelState = settings?.modelState.downloadState;
  const modelUnavailable = modelState !== "ready";
  // A blocked microphone cannot record, so the button leads to the one place that can fix it.
  const microphoneBlocked = isMicrophoneBlocked(permissionStatus);
  const startLabel = modelUnavailable ? modelState === "downloading" ? "הקלטה תתאפשר כשמנוע התמלול יסיים לרדת" : "הקלטה תתאפשר אחרי שמורידים את מנוע התמלול"
    : microphoneBlocked ? "הקלטה: פתיחת הגדרות המיקרופון" : undefined;
  const statusText = recording.isPreparing ? "פותחים את המיקרופון…"
    : appState.status === "error" ? he.error
    : appState.status === "recording" ? he.recording
    : appState.status === "paused" ? he.paused
    : appState.status === "youtube_downloading" ? he.visualizerDownloading
    : appState.status === "processing" ? appState.activeSourceType === "youtube" ? he.youtubeTranscribing : he.visualizerThinking
    : permissionStatus !== "granted" ? he.permissionNeeded
    : modelUnavailable ? modelState === "downloading" ? he.modelDownloading : he.modelMissing : he.idle;
  const blocked = appState.status === "error" || (!capturing && !processing && !recording.isPreparing && statusText !== he.idle && statusText !== he.modelDownloading);
  const tone = appState.status === "recording" ? "live" : blocked ? "alert" : statusText === he.idle ? "ok" : undefined;
  const visualizerState: AgentState = appState.status === "recording" ? "speaking" : appState.status === "paused" ? "listening" : processing ? "thinking" : "idle";
  const nearLimit = capturing && isNearRecordingLimit(elapsed);
  // A message gets its own wrapping line under the status, so its recovery half is never cut off.
  const message = appState.status === "error" && appState.lastError ? getHebrewErrorMessage(appState.lastError) : nearLimit ? he.recordingLimitSoon : null;
  const source = message ? null : youtubeWork ? appState.currentYoutubeJob?.title ?? he.youtubeLabel : selectedLabel;
  // The mic name doubles as the picker while nothing is running, so switching input doesn't need a trip to settings.
  const selectedId = settings?.microphoneDeviceId ?? null;
  const canPickMicrophone = source === selectedLabel && !capturing && !processing && !recording.isPreparing && permissionStatus === "granted" && devices.length > 1;
  // Past its estimate the countdown would sit on "~ 00:00", which reads as stuck.
  // At rest there is nothing to time, so the clock only appears once a recording starts.
  const time = processing ? remaining !== null && remaining >= 1000 ? `~ ${formatDurationMs(remaining)}` : "" : capturing ? formatDurationMs(elapsed) : "";
  const cancelProcessing = () => appState.activeSourceType === "youtube" || appState.status === "youtube_downloading"
    ? cancelActiveYouTube() : window.ivritMenuBar.transcription.cancel();
  const runAction = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { setErrorMessage(getHebrewErrorMessage(error, "הפעולה לא הושלמה. אפשר לנסות שוב.")); }
  };

  return <section className={`capture-area device state-${appState.status}`} data-tone={tone} data-capturing={capturing || processing} data-links={appState.linkImportAvailable === false ? "off" : undefined} aria-label="בקר הקלטה">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{nearLimit ? he.recordingLimitSoon : appState.status === "error" && message ? `${statusText}: ${message}` : statusText}</p>
    <div className="deck">
      <div className="deck-top">
        <span className="led" data-tone={tone} />
        <span className="deck-status" aria-hidden="true">{statusText}</span>
        {canPickMicrophone ? <label className="deck-source deck-source-pick app-no-drag" title={he.microphoneInput}>
          <span className="deck-source-name" dir="auto">{source}</span>
          <CaretDown className="deck-source-caret" />
          <select aria-label={he.microphoneInput} value={selectedId ?? ""}
            onChange={event => { const deviceId = event.target.value || null; void runAction(() => updateSetting("microphoneDeviceId", deviceId)); }}>
            {selectedId && !devices.some(device => device.deviceId === selectedId) && <option value={selectedId}>{he.microphoneUnavailable}</option>}
            <option value="">{he.systemMicrophone}</option>
            {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
        </label> : source ? <span className="deck-source" title={source} dir="auto">{source}</span> : null}
        {!capturing && !processing && <Button type="button" variant="ghost" size="icon-sm" className="deck-overlay app-no-drag" aria-label={he.floatingWindow} title={he.floatingWindow}
          onClick={() => void runAction(() => window.ivritMenuBar.overlay.open())}><FloatingWindow /></Button>}
      </div>
      {message && <p className="deck-message" aria-hidden="true">{message}</p>}
      <BarVisualizer state={visualizerState} mediaStream={recording.mediaStream} barCount={56} minHeight={4} maxHeight={100} aria-hidden="true" />
      <div className="deck-bottom">
        {processing ? <div className="capsule control-dock app-no-drag" data-quiet="true">
          <RecordButton mode="cancel" className="record-action" onClick={() => void runAction(cancelProcessing)} />
        </div> : capturing ? <div className="capsule control-dock app-no-drag">
          <RecordButton ref={primaryAction} mode="stop" className="record-action" disabled={recording.isPreparing} onClick={() => void runAction(recording.stopRecording)} />
          <RecordButton mode={appState.status === "paused" ? "resume" : "pause"} disabled={recording.isPreparing}
            onClick={() => void runAction(appState.status === "paused" ? recording.resumeRecording : recording.pauseRecording)} />
          <Button type="button" variant="plain" className="capsule-round" aria-label="ביטול ההקלטה" title="ביטול ההקלטה" disabled={recording.isPreparing} focusableWhenDisabled
            onClick={() => { primaryAction.current?.focus(); void runAction(recording.cancelRecording); }}><X /></Button>
        </div> : <div className="capsule app-no-drag" data-quiet={modelUnavailable}>
          <RecordButton mode="start" className="record-action" disabled={recording.isPreparing || modelUnavailable} label={startLabel} keyShortcuts={settings?.shortcut ? toAriaKeyShortcuts(settings.shortcut) : undefined}
            onClick={() => void runAction(microphoneBlocked ? () => window.ivritMenuBar.permissions.openMicrophoneSettings() : recording.startRecording)}>
            {settings?.shortcut && <kbd dir="ltr" aria-hidden="true">{formatShortcut(settings.shortcut)}</kbd>}
          </RecordButton>
        </div>}
        {recording.heldRecording?.reason === "failed" && !capturing && !processing && <Button type="button" size="sm" variant="secondary" className="app-no-drag" onClick={() => { setErrorMessage(null); void runAction(recording.resendHeldRecording); }}>{he.retryTranscription}</Button>}
        <span className="deck-time" dir="ltr" aria-hidden="true">{time}</span>
      </div>
    </div>
    <FileDropCell disabled={capturing || processing || recording.isPreparing || modelUnavailable} onPick={() => void runAction(importAudio)} onDropFile={file => void runAction(() => importDroppedAudio(file))} />
    {appState.linkImportAvailable !== false && <div id="youtube-source" className="youtube-source"><YouTubeInputRow /></div>}
  </section>;
}
