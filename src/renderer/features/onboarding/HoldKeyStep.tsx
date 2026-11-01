import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { he } from "@shared/locale";
import type { HoldKeyChoice, HoldKeyStatus } from "@shared/types";
import { OnboardingStepShell } from "./OnboardingStepShell";

export function HoldKeyStep({ choice, status, asked, onChoose, onOpenSettings, actions }: {
  choice: HoldKeyChoice; status: HoldKeyStatus; asked: boolean; onChoose: (key: HoldKeyChoice) => void; onOpenSettings: () => void; actions?: ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  const [worked, setWorked] = useState(false);
  useEffect(() => window.ivritMenuBar.app.onHoldKeyPressed((next) => {
    setPressed(next);
    if (next) setWorked(true);
  }), []);
  useEffect(() => setWorked(false), [choice]);

  const off = choice === "off";
  const message = off ? he.holdKeyOffMessage : status === "needs_permission" ? he.holdKeyPermissionNeeded
    : status === "unavailable" ? he.holdKeyUnavailable : status === "off" ? he.holdKeyChecking
      : worked ? he.holdKeyWorks : he.holdKeyTryIt;
  return <OnboardingStepShell stepLabel={he.stepHoldKey} title={he.onboardingHoldKeyTitle} description={he.onboardingHoldKeyBody} actions={actions}>
    <div className={`onboarding-microphone ${pressed ? "is-live" : ""} ${worked ? "is-detected" : ""}`}>
      <div className="demo-stage">
        <p className="microphone-feedback" role="status"><span className="led" data-tone={pressed ? "live" : worked ? "ok" : undefined} />{message}</p>
        {status === "needs_permission" && asked && <Button variant="secondary" size="sm" onClick={onOpenSettings}>{he.holdKeyOpenSettings}</Button>}
        <Select aria-label={he.holdKeyInput} value={choice} onChange={(event) => onChoose(event.target.value as HoldKeyChoice)}>
          <option value="right_option">{he.holdKeyRightOption}</option>
          <option value="right_command">{he.holdKeyRightCommand}</option>
          <option value="off">{he.holdKeyOff}</option>
        </Select>
      </div>
      <div className="demo-transport"><span>{he.holdKeyPrivacy}</span></div>
    </div>
  </OnboardingStepShell>;
}
