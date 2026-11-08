import { useRef, useState } from "react";
import { DownloadSimple, Microphone, Warning } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import type { OnboardingPhase } from "@shared/types";

export function OnboardingWorkspaceCard({ phase, onResumeSetup }: { phase: OnboardingPhase; onResumeSetup: () => void }) {
  const { settings, modelProgress, downloadModel } = useAppContext();
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const state = settings?.modelState.downloadState;
  const downloading = state === "downloading", failed = state === "error";
  const percent = modelProgress?.percent ?? (modelProgress?.totalBytes ? modelProgress.bytesDownloaded / modelProgress.totalBytes * 100 : null);
  const progress = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  const retry = async () => {
    if (lock.current) return;
    lock.current = true; setPending(true);
    // A failure comes back through the model state, which this card already shows.
    await downloadModel().catch(() => undefined);
    lock.current = false; setPending(false);
  };
  const activated = phase === "activated";
  // An untested microphone blocks dictation, so it leads; the download keeps its progress bar underneath.
  const needsMic = phase === "needs_mic";
  const title = needsMic ? he.onboardingCardMicTitle : downloading ? he.onboardingCardDownloading : failed ? he.onboardingCardFailed : activated ? he.modelMissing : he.onboardingCardAlmost;
  const detail = needsMic ? he.onboardingCardMicBody : downloading ? he.onboardingCardDownloadingBody : failed
    ? getHebrewErrorMessage(settings?.modelState.lastError, he.modelDownloadFailed)
    : activated ? he.modelMissingBody : he.onboardingCardModelBody;
  return <section className="workspace-setup-status" aria-label={he.onboardingCardStatus}>
    {needsMic ? <Microphone /> : failed ? <Warning /> : <DownloadSimple />}
    <div className="workspace-setup-copy"><strong role="status">{title}</strong><p>{detail}</p>
      {downloading && <div className="background-download" role="progressbar" aria-label={he.modelDownloading} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
        <div className="progress-track"><div className="progress-fill" style={{ transform: `scaleX(${(progress ?? 0) / 100})` }} /></div>
        <span dir="ltr">{progress !== null ? `${progress}%` : "…"}</span>
      </div>}
    </div>
    {needsMic ? <Button variant="secondary" size="sm" onClick={onResumeSetup}>{he.onboardingResumeSetup}</Button>
      : downloading ? null
      : failed || activated ? <Button variant="secondary" size="sm" aria-disabled={pending} onClick={() => void retry()}>{failed ? he.retry : he.downloadHebrewModel}</Button>
      : <Button variant="secondary" size="sm" onClick={onResumeSetup}>{he.onboardingResumeSetup}</Button>}
  </section>;
}
