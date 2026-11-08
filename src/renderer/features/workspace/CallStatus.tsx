import { useState } from "react";
import { InlineConfirm } from "@/components/InlineConfirm";
import { Phone, Warning } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { he } from "@shared/locale";
import { getHebrewErrorMessage } from "@shared/error-utils";
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
  const { appState, setErrorMessage } = useAppContext();
  const [discardId, setDiscardId] = useState<string | null>(null);
  const call = appState.call;
  if (!call) return null;
  const calls = window.ivritMenuBar.call;
  const run = (action: () => Promise<unknown> | unknown) => {
    void Promise.resolve().then(action).catch((error: unknown) => setErrorMessage(getHebrewErrorMessage(error, he.actionFailed)));
  };
  return <>
    {call.processing && <section className="workspace-setup-status" aria-label={he.callProcessing}>
      <Phone />
      {/* The bar carries the progress; only waiting is worth announcing. */}
      <div className="workspace-setup-copy">
        <strong>{he.callProcessing}</strong>
        <div className="progress-row"><div className="progress-track"><div className="progress-fill" style={{ transform: `scaleX(${call.processing.progressRatio})` }} /></div><span className="tabular">{Math.round(call.processing.progressRatio * 100)}%</span></div>
        <p role="status">{call.processing.waiting ? he.callProcessingWaiting : ""}</p>
      </div>
    </section>}
    {call.failures.map((failure) => discardId === failure.id
      ? <InlineConfirm key={failure.id} title={he.callDiscardTitle} body={he.callDiscardBody} confirmLabel={he.callDiscardConfirm}
        onConfirm={async () => { await calls.discard(failure.id); setDiscardId(null); }} onCancel={() => setDiscardId(null)} />
      : <section key={failure.id} className="workspace-setup-status" aria-label={he.callFailed}>
      <Warning />
      <div className="workspace-setup-copy"><strong role="status">{he.callFailed}</strong><p>{he.callFailedBody}</p></div>
      <div className="workspace-setup-actions">
        <Button size="sm" variant="secondary" onClick={() => run(() => calls.retry(failure.id))}>{he.retry}</Button>
        <Button size="sm" variant="ghost" onClick={() => setDiscardId(failure.id)}>{he.callDiscard}</Button>
      </div>
    </section>)}
    {call.notice && <section className="workspace-setup-status" aria-label={he.callNoticeTitle}>
      <Warning />
      <div className="workspace-setup-copy"><strong role="status">{NOTICES[call.notice]}</strong></div>
      <div className="workspace-setup-actions">
        {call.notice === "others_silent" && <Button size="sm" variant="secondary" onClick={() => run(() => calls.openAudioSettings())}>{he.openSystemSettings}</Button>}
        <Button size="sm" variant="ghost" onClick={() => run(() => calls.dismissNotice())}>{he.close}</Button>
      </div>
    </section>}
  </>;
}
