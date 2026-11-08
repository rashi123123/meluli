import type { ReactNode } from "react";
import { he } from "@shared/locale";
import { OnboardingStepShell } from "./OnboardingStepShell";

/** Asks for Accessibility, which pasting into other apps needs. The note under the buttons says what Not Now means. */
export function PasteStep({ allowed, waiting, actions }: { allowed: boolean; waiting: boolean; actions?: ReactNode }) {
  const status = allowed ? he.onboardingPasteAllowed : waiting ? he.onboardingPasteWaiting : null;
  return <OnboardingStepShell stepLabel={he.accessibility} title={he.onboardingPasteTitle} description={he.onboardingPasteBody} actions={actions}>
    <div className={`onboarding-paste setup-panel${waiting && !allowed ? " state-processing" : ""}`} data-tone={allowed ? "ok" : undefined}>
      <div className="demo-stage">
        <p className="setup-status paste-status" role="status" data-empty={!status || undefined}>
          {status && <><span className="led" data-tone={allowed ? "ok" : "live"} />{status}</>}
        </p>
        {!allowed && <p className="paste-how">{he.onboardingPasteHow}</p>}
      </div>
    </div>
  </OnboardingStepShell>;
}
