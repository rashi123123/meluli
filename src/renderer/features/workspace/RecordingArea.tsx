import { useEffect, useRef, useState } from "react";
import { FloatingWindow, X } from "@/components/icons";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { getRemainingEstimateMs } from "@shared/processing-estimate";
import { RecordButton } from "@/components/RecordButton";
import { BarVisualizer, type AgentState } from "@/components/ui/bar-visualizer";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { useMicrophoneDevices } from "@/hooks/use-microphone-devices";
import { formatDurationMs } from "@/lib/format";
import { formatShortcut } from "@/lib/shortcut";
import { isNearRecordingLimit } from "@shared/constants";
import { he } from "@shared/locale";
import { FileDropCell } from "./FileDropCell";
import { YouTubeInputRow } from "./YouTubeInputRow";

export function RecordingArea() {
  const { appState, recording, settings, permissionStatus, importAudio, importDroppedAudio, cancelActiveYouTube, setErrorMessage } = useAppContext();
  const [now, setNow] = useState(Date.now());
  const primaryAction = useRef<HTMLButtonElement>(null);
  const { selectedLabel } = useMicrophoneDevices(settings?.microphoneDeviceId, permissionStatus);
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
  const source = appState.status === "error" && appState.lastError ? getHebrewErrorMessage(appState.lastError)
    : nearLimit ? he.recordingLimitSoon
    : youtubeWork ? appState.currentYoutubeJob?.title ?? he.youtubeLabel : selectedLabel;
  const time = processing ? remaining !== null ? `~ ${formatDurationMs(remaining)}` : "" : formatDurationMs(elapsed);
  const cancelProcessing = () => appState.activeSourceType === "youtube" || appState.status === "youtube_downloading"
    ? cancelActiveYouTube() : window.ivritMenuBar.transcription.cancel();
  const runAction = async (action: () => Promise<unknown>) => {
    try { await action(); } catch { setErrorMessage("הפעולה לא הושלמה. אפשר לנסות שוב."); }
  };

  return <section className={`capture-area device state-${appState.status}`} data-tone={tone} data-capturing={capturing || processing} data-links={appState.linkImportAvailable === false ? "off" : undefined} aria-label="בקר הקלטה">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{nearLimit ? he.recordingLimitSoon : statusText}</p>
    <div className="deck">
      <div className="deck-top">
        <span className="led" data-tone={tone} />
        <span className="deck-status" aria-hidden="true">{statusText}</span>
        <span className="deck-source" title={source} dir="auto">{source}</span>
      </div>
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
          <RecordButton mode="start" className="record-action" disabled={recording.isPreparing || modelUnavailable} onClick={() => void runAction(recording.startRecording)}>
            {settings?.shortcut && <kbd dir="ltr">{formatShortcut(settings.shortcut)}</kbd>}
          </RecordButton>
          <Button type="button" variant="plain" className="capsule-round" aria-label="חלון צף" title="חלון צף" onClick={() => void runAction(() => window.ivritMenuBar.overlay.open())}><FloatingWindow /></Button>
        </div>}
        {recording.heldRecording?.reason === "failed" && !capturing && !processing && <Button type="button" size="sm" variant="secondary" className="app-no-drag" onClick={() => { setErrorMessage(null); void runAction(recording.resendHeldRecording); }}>{he.retryTranscription}</Button>}
        <span className="deck-time" dir="ltr" aria-hidden="true">{time}</span>
      </div>
    </div>
    <FileDropCell disabled={capturing || processing || recording.isPreparing || modelUnavailable} onPick={() => void runAction(importAudio)} onDropFile={file => void runAction(() => importDroppedAudio(file))} />
    {appState.linkImportAvailable !== false && <div id="youtube-source" className="youtube-source"><YouTubeInputRow /></div>}
  </section>;
}
