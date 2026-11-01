import { useRef, useState } from "react";
import { DownloadSimple, Warning } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import type { OnboardingPhase, OnboardingStepKey } from "@shared/types";

export function OnboardingWorkspaceCard({ phase, onResumeSetup }: {
  phase: OnboardingPhase; activeStep: OnboardingStepKey; onResumeSetup: () => void;
}) {
  const { settings, modelProgress, downloadModel, setActiveView } = useAppContext();
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
  const title = downloading ? "מורידים את מנוע התמלול" : failed ? "ההורדה נעצרה" : activated ? he.modelMissing : "עוד רגע אפשר להתחיל";
  const detail = downloading ? "אפשר להסתכל מסביב. נעדכן כאן כשהכול מוכן." : failed
    ? getHebrewErrorMessage(settings?.modelState.lastError, he.modelDownloadFailed)
    : activated ? he.modelMissingBody
    : phase === "needs_mic" ? "נבדוק את המיקרופון לפני ההקלטה הראשונה." : "בדיקה קצרה של המיקרופון והורדה חד־פעמית.";
  return <section className="workspace-setup-status" aria-label="מצב ההגדרה">
    {failed ? <Warning /> : <DownloadSimple />}
    <div className="workspace-setup-copy"><strong role="status">{title}</strong><p>{detail}</p>
      {downloading && <div className="background-download" role="progressbar" aria-label={he.modelDownloading} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
        <div className="progress-track"><div className="progress-fill" style={{ transform: `scaleX(${(progress ?? 0) / 100})` }} /></div>
        <span dir="ltr">{progress !== null ? `${progress}%` : "…"}</span>
      </div>}
    </div>
    {downloading ? <Button variant="ghost" size="sm" onClick={() => setActiveView("settings")}>פרטי ההורדה</Button>
      : failed || activated ? <Button variant="secondary" size="sm" aria-disabled={pending} onClick={() => void retry()}>{failed ? he.retry : he.downloadHebrewModel}</Button>
        : <Button variant="secondary" size="sm" onClick={onResumeSetup}>{he.onboardingResumeSetup}</Button>}
  </section>;
}
