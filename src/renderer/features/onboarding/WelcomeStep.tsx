import type { ReactNode } from "react";
import appMark from "@/assets/app-mark.png";
import { he } from "@shared/locale";
import { OnboardingStepShell } from "./OnboardingStepShell";
import { SpeechDemo } from "./SpeechDemo";

// The first screen arrives in beats: the mark comes into focus, then the promise, then the way in.
export function WelcomeStep({ actions }: { actions?: ReactNode }) {
  return <OnboardingStepShell className="onboarding-welcome" stepLabel={he.onboardingWelcomeRegion} title={he.onboardingWelcomeTitle} description={he.onboardingWelcomeBody}
    lead={<img className="onboarding-mark" src={appMark} alt="" />} actions={actions}>
    <SpeechDemo />
  </OnboardingStepShell>;
}
