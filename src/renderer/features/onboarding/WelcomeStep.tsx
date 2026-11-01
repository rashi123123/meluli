import type { ReactNode } from "react";
import { he } from "@shared/locale";
import { OnboardingStepShell } from "./OnboardingStepShell";
import { SpeechDemo } from "./SpeechDemo";

export function WelcomeStep({ actions }: { actions?: ReactNode }) {
  return <OnboardingStepShell stepLabel={he.stepReady} title={he.onboardingWelcomeTitle} description={he.onboardingWelcomeBody} actions={actions}>
    <SpeechDemo />
  </OnboardingStepShell>;
}
