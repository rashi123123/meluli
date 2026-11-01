import { Warning } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { he } from "@shared/locale";
import type { CallNotice } from "@shared/types";

const NOTICES: Record<CallNotice, string> = {
  no_speech: he.callNoticeNoSpeech,
  others_silent: he.callNoticeOthersSilent,
  partial_audio: he.callNoticePartial,
  low_disk: he.callNoticeLowDisk,
  start_failed: he.callNoticeStartFailed,
  needs_microphone: he.callNoticeNeedsMicrophone
};

export function CallStatus() {
  const { appState } = useAppContext();
  const call = appState.call;
  if (!call) return null;
  const calls = window.ivritMenuBar.call;
  return <>
    {call.processing && <section className="workspace-setup-status" aria-label={he.callProcessing}>
      <div className="workspace-setup-copy">
        <strong role="status">{he.callProcessing} · {Math.round(call.processing.progressRatio * 100)}%</strong>
        {call.processing.waiting && <p>{he.callProcessingWaiting}</p>}
      </div>
    </section>}
    {call.failures.map((failure) => <section key={failure.id} className="workspace-setup-status" aria-label={he.callFailed}>
      <Warning />
      <div className="workspace-setup-copy"><strong role="status">{he.callFailed}</strong><p>{he.callFailedBody}</p></div>
      <div className="workspace-setup-actions">
        <Button size="sm" variant="secondary" onClick={() => void calls.retry(failure.id)}>{he.retry}</Button>
        <Button size="sm" variant="plain" onClick={() => void calls.discard(failure.id)}>{he.callDiscard}</Button>
      </div>
    </section>)}
    {call.notice && <section className="workspace-setup-status" aria-label={he.callNoticeTitle}>
      <Warning />
      <div className="workspace-setup-copy"><strong role="status">{NOTICES[call.notice]}</strong></div>
      <div className="workspace-setup-actions">
        {call.notice === "others_silent" && <Button size="sm" variant="secondary" onClick={() => void calls.openAudioSettings()}>{he.openSystemSettings}</Button>}
        <Button size="sm" variant="plain" onClick={() => void calls.dismissNotice()}>{he.close}</Button>
      </div>
    </section>}
  </>;
}
