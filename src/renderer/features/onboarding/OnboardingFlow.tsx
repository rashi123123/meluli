import { useEffect, useRef, useState } from "react";
import { useAppContext } from "@/context/app-context";
import { useMicrophoneCheck } from "@/hooks/use-microphone-check";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import { WelcomeStep } from "./WelcomeStep";
import { MicrophoneStep } from "./MicrophoneStep";
import { HoldKeyStep } from "./HoldKeyStep";
import { ModelDownloadStep } from "./ModelDownloadStep";
import { OnboardingBottomBar } from "./OnboardingBottomBar";

export function OnboardingFlow() {
  const { settings, permissionStatus, onboarding, modelProgress, appState, recording,
    trackOnboardingStepViewed, completeOnboardingStep, continueOnboardingLater, goBackOnboardingStep,
    requestMicrophonePermission, downloadModel, updateSetting, setErrorMessage } = useAppContext();
  const [pendingNavigation, setPendingNavigation] = useState<"primary" | "secondary" | null>(null);
  const [holdKeyAsked, setHoldKeyAsked] = useState(false);
  const navigationLock = useRef(false);
  const modelLock = useRef(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const captureBusy = Boolean(recording?.isPreparing || (appState && appState.status !== "idle" && appState.status !== "error"));
  const microphone = useMicrophoneCheck({
    enabled: onboarding?.step === "microphone" && !captureBusy,
    deviceId: settings?.microphoneDeviceId ?? undefined,
    onRequestPermission: () => requestMicrophonePermission({ advanceOnboarding: false })
  });
  const onMicrophoneStep = onboarding?.phase === "needs_mic";
  // Reaching this step is the go-ahead, so the check runs without another click.
  const checkStopped = useRef(false);
  const startCheck = microphone.start;
  useEffect(() => {
    if (!onMicrophoneStep) checkStopped.current = false;
    else if (microphone.status === "idle" && !captureBusy && !checkStopped.current) void startCheck();
  }, [onMicrophoneStep, microphone.status, captureBusy, startCheck]);
  const navigate = async (action: () => Promise<unknown>, source: "primary" | "secondary" = "secondary") => {
    if (navigationLock.current) return;
    navigationLock.current = true;
    setPendingNavigation(source);
    try { await action(); }
    catch (error) { setErrorMessage(getHebrewErrorMessage(error, "הפעולה לא הושלמה. אפשר לנסות שוב.")); }
    finally { navigationLock.current = false; setPendingNavigation(null); }
  };
  const beginDownload = async () => {
    if (settings?.modelState.downloadState === "ready") return completeOnboardingStep("local_install");
    if (!modelLock.current && settings?.modelState.downloadState !== "downloading") {
      modelLock.current = true;
      // The provider owns this operation after the setup view unmounts, and Home's status card reports a failure.
      void downloadModel().catch(() => undefined).finally(() => { modelLock.current = false; });
    }
    await continueOnboardingLater("local_install");
  };
  const lastTrackedStep = useRef<string | null>(null);
  useEffect(() => {
    if (!onboarding || lastTrackedStep.current === onboarding.step) return;
    lastTrackedStep.current = onboarding.step;
    flowRef.current?.querySelector<HTMLElement>("[data-onboarding-heading]")?.focus();
    void Promise.resolve(trackOnboardingStepViewed(onboarding.step)).catch(error => setErrorMessage(getHebrewErrorMessage(error, "שמירת ההתקדמות לא הושלמה.")));
  }, [onboarding?.step, trackOnboardingStepViewed]);

  if (!settings || !onboarding) return null;
  const phase = onboarding.phase;
  const live = microphone.status === "listening" || microphone.status === "detected";
  const holdKeyStatus = appState?.holdKey?.status ?? "off";
  // macOS asks only once. After that the step moves on, and the system pane stays one click away.
  const askHoldKey = settings.holdKey !== "off" && holdKeyStatus === "needs_permission" && !holdKeyAsked;
  const askHoldKeyPermission = async () => {
    await window.ivritMenuBar.permissions.requestHoldKey();
    setHoldKeyAsked(true);
  };
  const action = phase === "not_started" ? () => completeOnboardingStep("ready")
    : phase === "needs_mic" ? live ? async () => { checkStopped.current = true; microphone.stop(); await completeOnboardingStep("microphone"); } : async () => { checkStopped.current = false; await microphone.start(); }
    : phase === "needs_hold_key" ? askHoldKey ? askHoldKeyPermission : () => completeOnboardingStep("hold_key")
    : beginDownload;
  const label = phase === "not_started" ? he.onboardingStartSetup : phase === "needs_mic"
    ? microphone.status === "requesting" ? "פותחים את המיקרופון…" : live ? he.continue : he.onboardingMicrophoneAction
    : phase === "needs_hold_key" ? askHoldKey ? he.holdKeyAllow : he.continue
    : settings.modelState.downloadState === "ready" || settings.modelState.downloadState === "downloading" ? "למסך הבית" : settings.modelState.downloadState === "error" ? he.retry : he.onboardingInstallAction;
  const actions = <OnboardingBottomBar primaryContent={label} onPrimary={() => void navigate(action, "primary")}
    primaryDisabled={phase === "needs_mic" && captureBusy} primaryPending={pendingNavigation === "primary"} navigationPending={pendingNavigation !== null}
    onSkip={phase === "not_started" ? undefined : () => void navigate(() => continueOnboardingLater(onboarding.step))}
    onBack={() => void navigate(goBackOnboardingStep)} showBack={phase !== "not_started"} />;

  return <div ref={flowRef} className="onboarding-flow">
    <div className="onboarding-surface"><section className="onboarding-channel" aria-label={he.onboardingQuickSetup}>
      <div className="onboarding-content"><div key={onboarding.step} className="onboarding-step">
        {phase === "not_started" && <WelcomeStep actions={actions} />}
        {phase === "needs_mic" && <MicrophoneStep permissionStatus={permissionStatus} status={microphone.status} level={microphone.level} error={microphone.error} unavailable={captureBusy}
          deviceId={settings.microphoneDeviceId} onSelectDevice={(deviceId) => void updateSetting("microphoneDeviceId", deviceId).catch(error => setErrorMessage(getHebrewErrorMessage(error, "הפעולה לא הושלמה. אפשר לנסות שוב.")))} onStop={() => { checkStopped.current = true; microphone.stop(); requestAnimationFrame(() => flowRef.current?.querySelector<HTMLButtonElement>('[data-onboarding-action="primary"]')?.focus()); }} onOpenSettings={() => void navigate(() => window.ivritMenuBar.permissions.openMicrophoneSettings())} actions={actions} />}
        {phase === "needs_hold_key" && <HoldKeyStep choice={settings.holdKey} status={holdKeyStatus} asked={holdKeyAsked} actions={actions}
          onChoose={(key) => void updateSetting("holdKey", key).catch(error => setErrorMessage(getHebrewErrorMessage(error, "הפעולה לא הושלמה. אפשר לנסות שוב.")))}
          onOpenSettings={() => void window.ivritMenuBar.permissions.openHoldKeySettings()} />}
        {phase === "needs_model" && <ModelDownloadStep settings={settings} progress={modelProgress} actions={actions} />}
      </div></div>
    </section></div>
  </div>;
}
