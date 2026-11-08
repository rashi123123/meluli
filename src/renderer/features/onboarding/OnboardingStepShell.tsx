import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function OnboardingStepShell({ stepLabel, title, description, lead, children, actions, className }: {
  stepLabel: string; title: string; description: string; lead?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string;
}) {
  return <section className={cn("onboarding-step-body", className)} aria-label={stepLabel}>
    <div className="onboarding-copy">
      <header className="onboarding-step-heading">
        {lead}
        <div className="onboarding-introduction"><h2 tabIndex={-1} data-onboarding-heading>{title}</h2><p>{description}</p></div>
      </header>
      {actions}
    </div>
    <div className="onboarding-step-details">{children}</div>
  </section>;
}
