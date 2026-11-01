import type { ReactNode } from "react";
import { ArrowLeft } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { he } from "@shared/locale";

export function OnboardingBottomBar({ primaryContent, onPrimary, onSkip, onBack, primaryDisabled = false, primaryPending = false, navigationPending = false, showBack = false }: {
  primaryContent: ReactNode; onPrimary: () => void; onSkip?: () => void; onBack?: () => void; primaryDisabled?: boolean; primaryPending?: boolean; navigationPending?: boolean; showBack?: boolean;
}) {
  const primaryUnavailable = primaryDisabled || primaryPending || navigationPending;
  return <footer className="onboarding-actions">
    <div className="onboarding-primary-dock">
      <Button size="lg" className="onboarding-primary" onClick={() => { if (!primaryUnavailable) onPrimary(); }} data-onboarding-action="primary" disabled={primaryDisabled} aria-disabled={primaryPending || navigationPending || undefined} aria-busy={primaryPending || undefined}>
        <span>{primaryContent}</span><ArrowLeft />
      </Button>
    </div>
    {(showBack || onSkip) && <div className="onboarding-secondary-dock">
      {showBack && onBack && <Button variant="ghost" size="sm" aria-disabled={navigationPending || undefined} onClick={() => { if (!navigationPending) onBack(); }}>{he.back}</Button>}
      {onSkip && <Button variant="ghost" size="sm" aria-disabled={navigationPending || undefined} onClick={() => { if (!navigationPending) onSkip(); }}>{he.onboardingContinueLater}</Button>}
    </div>}
  </footer>;
}
