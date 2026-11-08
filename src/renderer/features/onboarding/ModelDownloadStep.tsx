import type { ReactNode } from "react";
import { Check, DownloadSimple, Warning } from "@/components/icons";
import { formatBytes } from "@/lib/bytes";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import type { AppSettings, ModelDownloadProgress } from "@shared/types";
import { OnboardingStepShell } from "./OnboardingStepShell";
import { PanelSweep } from "@/components/milestone-sweep";

export function ModelDownloadStep({ settings, progress, actions }: { settings: AppSettings; progress: ModelDownloadProgress | null; actions?: ReactNode }) {
  const state = settings.modelState.downloadState;
  const ready = state === "ready", downloading = state === "downloading", failed = state === "error";
  const percent = progress?.percent ?? (progress?.totalBytes && progress.totalBytes > 0 ? Math.round(progress.bytesDownloaded / progress.totalBytes * 100) : null);
  const value = percent == null ? null : Math.max(0, Math.min(100, percent));
  const status = ready ? he.modelReady : failed ? getHebrewErrorMessage(settings.modelState.lastError, he.onboardingModelErrorHint) : downloading ? he.modelDownloading : he.onboardingModelNotYet;
  const size = progress?.totalBytes ?? settings.modelState.totalBytes;
  return <OnboardingStepShell stepLabel={he.stepModel} title={he.onboardingModelTitle} description={he.onboardingModelBody} actions={actions}>
    <div className={`onboarding-local-model setup-panel${downloading ? " state-processing" : ""}`} data-tone={ready ? "ok" : failed ? "alert" : undefined}>
      <PanelSweep done={ready}><div className="demo-stage">
        <div className="local-model-name"><strong>{he.onboardingModelName}</strong><span>{he.onboardingModelWhere}</span></div>
        <div className="local-model-status">
          <p className={`setup-status ${failed ? "is-error" : ""}`} role="status">{ready ? <Check /> : failed ? <Warning /> : <DownloadSimple />}{status}</p>
          {downloading && <div className="setup-download-progress progress-row" role="progressbar" aria-label={he.modelDownloading} aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-track"><div className="progress-fill" style={{ transform: `scaleX(${(value ?? 0) / 100})` }} /></div>
            <span className="tabular" dir="ltr">{value != null ? `${value}%` : he.downloadInProgress}</span>
          </div>}
        </div>
        <ul className="local-model-facts">
          {size != null && size > 0 && <li><span>{he.onboardingModelSize}</span><span className="tabular" dir="ltr">{formatBytes(size)}</span></li>}
          <li><span>{he.onboardingModelInternet}</span><span>{he.onboardingModelInternetOnce}</span></li>
          <li><span>{he.onboardingModelPrivacy}</span><span>{he.onboardingModelPrivacyStays}</span></li>
        </ul>
      </div></PanelSweep>
    </div>
  </OnboardingStepShell>;
}
