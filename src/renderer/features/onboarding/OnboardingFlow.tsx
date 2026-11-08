import { useEffect, useRef, useState } from "react";
import { useAppContext } from "@/context/app-context";
import { useMicrophoneCheck } from "@/hooks/use-microphone-check";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import { WelcomeStep } from "./WelcomeStep";
import { MicrophoneStep } from "./MicrophoneStep";
import { PasteStep } from "./PasteStep";
import { ModelDownloadStep } from "./ModelDownloadStep";
import { OnboardingBottomBar } from "./OnboardingBottomBar";
import { useMilestoneSweep } from "@/components/milestone-sweep";

const PASTE_POLL_MS = 1000;

export function OnboardingFlow() {
  const { settings, permissionStatus, accessibilityPermissionStatus, onboarding, modelProgress, appState, recording,
    trackOnboardingStepViewed, completeOnboardingStep, continueOnboardingLater, goBackOnboardingStep,
    requestMicrophonePermission, requestAccessibilityPermission, downloadModel, updateSetting, setErrorMessage } = useAppContext();
  const [pendingNavigation, setPendingNavigation] = useState<"primary" | "secondary" | null>(null);
  const navigationLock = useRef(false);
  const modelLock = useRef(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const milestoneSweep = useMilestoneSweep();
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
  // Access granted in System Settings after a refusal: run the check again without another click.
  const previousPermission = useRef(permissionStatus);
  useEffect(() => {
    const before = previousPermission.current;
    previousPermission.current = permissionStatus;
    if (onMicrophoneStep && permissionStatus === "granted" && before !== "granted" && microphone.status === "error" && !captureBusy) void startCheck();
  }, [onMicrophoneStep, permissionStatus, microphone.status, captureBusy, startCheck]);

  // Accessibility is granted in System Settings, outside this window, so the step watches for it while it waits.
  const onPasteStep = onboarding?.phase === "needs_paste";
  const [pasteWaiting, setPasteWaiting] = useState(false);
  const [pasteGranted, setPasteGranted] = useState(false);
  const pasteAllowed = pasteGranted || accessibilityPermissionStatus === "granted";
  useEffect(() => {
    if (!onPasteStep) { setPasteWaiting(false); return; }
    if (!pasteWaiting || pasteAllowed) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void window.ivritMenuBar.permissions.accessibilityStatus().then(status => { if (!stopped && status === "granted") setPasteGranted(true); }).catch(() => undefined);
    }, PASTE_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [onPasteStep, pasteWaiting, pasteAllowed]);

  const navigate = async (action: () => Promise<unknown>, source: "primary" | "secondary" = "secondary") => {
    if (navigationLock.current) return;
    navigationLock.current = true;
    setPendingNavigation(source);
    try { await action(); }
    catch (error) { setErrorMessage(getHebrewErrorMessage(error, he.onboardingActionFailed)); }
    finally { navigationLock.current = false; setPendingNavigation(null); }
  };
  const startDownload = () => {
    if (modelLock.current || settings?.modelState.downloadState === "ready" || settings?.modelState.downloadState === "downloading") return;
    modelLock.current = true;
    // The provider owns this operation after the setup view unmounts, and Home's status card reports a failure.
    void downloadModel().catch(() => undefined).finally(() => { modelLock.current = false; });
  };
  const beginSetup = async () => {
    startDownload();
    await completeOnboardingStep("ready");
  };
  const beginDownload = async () => {
    if (settings?.modelState.downloadState === "ready") return completeOnboardingStep("local_install");
    startDownload();
    await continueOnboardingLater("local_install");
  };
  const askForPaste = async () => {
    if (pasteWaiting) return window.ivritMenuBar.permissions.openAccessibilitySettings();
    const status = await requestAccessibilityPermission();
    if (status === "granted") setPasteGranted(true);
    else setPasteWaiting(true);
  };
  const lastTrackedStep = useRef<string | null>(null);
  useEffect(() => {
    if (!onboarding || lastTrackedStep.current === onboarding.step) return;
    lastTrackedStep.current = onboarding.step;
    flowRef.current?.querySelector<HTMLElement>("[data-onboarding-heading]")?.focus();
    void Promise.resolve(trackOnboardingStepViewed(onboarding.step)).catch(error => setErrorMessage(getHebrewErrorMessage(error, he.onboardingProgressNotSaved)));
  }, [onboarding?.step, trackOnboardingStepViewed]);

  if (!settings || !onboarding) return null;
  const phase = onboarding.phase;
  const live = microphone.status === "listening" || microphone.status === "detected";
  const micDenied = permissionStatus === "denied" || permissionStatus === "restricted";
  const action = phase === "not_started" ? beginSetup
    : phase === "needs_mic" ? live ? async () => { checkStopped.current = true; microphone.stop(); await completeOnboardingStep("microphone"); }
      : micDenied ? () => window.ivritMenuBar.permissions.openMicrophoneSettings()
      : async () => { checkStopped.current = false; await microphone.start(); }
    : phase === "needs_paste" ? pasteAllowed ? () => completeOnboardingStep("paste") : askForPaste
    : beginDownload;
  const label = phase === "not_started" ? he.onboardingStartSetup : phase === "needs_mic"
    ? live ? he.continue : micDenied ? he.onboardingPasteOpenSettings : he.onboardingMicrophoneAction
    : phase === "needs_paste" ? pasteAllowed ? he.continue : pasteWaiting ? he.onboardingPasteOpenSettings : he.onboardingPasteAction
    : settings.modelState.downloadState === "ready" || settings.modelState.downloadState === "downloading" ? he.onboardingToHome : settings.modelState.downloadState === "error" ? he.retry : he.onboardingInstallAction;
  // Leaving setup is the milestone: the logo sweep carries the window into Home.
  // Finishing the microphone check leads Home when paste was allowed before setup.
  const finishesSetup = (phase === "needs_mic" && live && accessibilityPermissionStatus === "granted")
    || (phase === "needs_paste" && pasteAllowed) || (phase === "needs_model" && settings.modelState.downloadState !== "error");
  const skip = phase === "not_started" ? undefined
    : phase === "needs_paste" ? () => void navigate(() => completeOnboardingStep("paste", { declined: true }))
    : () => void navigate(() => continueOnboardingLater(onboarding.step));
  const actions = <OnboardingBottomBar primaryContent={label} onPrimary={finishesSetup
    ? () => milestoneSweep(flowRef.current?.querySelector('[data-onboarding-action="primary"]') ?? null, () => navigate(action, "primary"))
    : () => void navigate(action, "primary")}
    primaryDisabled={phase === "needs_mic" && captureBusy} primaryPending={pendingNavigation === "primary" || (phase === "needs_mic" && microphone.status === "requesting")} navigationPending={pendingNavigation !== null}
    onSkip={skip} skipLabel={phase === "needs_mic" || phase === "needs_paste" ? he.onboardingNotNow : undefined}
    note={phase === "not_started" ? he.onboardingDownloadNotice : phase === "needs_mic" && !live ? he.onboardingMicrophoneWithout : phase === "needs_paste" && !pasteAllowed ? he.onboardingPasteWithout : undefined}
    onBack={() => void navigate(goBackOnboardingStep)} showBack={phase !== "not_started"} />;

  return <div ref={flowRef} className="onboarding-flow">
    <div className="onboarding-surface"><section className="onboarding-channel" aria-label={he.onboardingQuickSetup}>
      <div className="onboarding-content"><div key={onboarding.step} className="onboarding-step">
        {phase === "not_started" && <WelcomeStep actions={actions} />}
        {phase === "needs_mic" && <MicrophoneStep permissionStatus={permissionStatus} status={microphone.status} level={microphone.level} error={microphone.error} unavailable={captureBusy}
          deviceId={settings.microphoneDeviceId} onSelectDevice={(deviceId) => void updateSetting("microphoneDeviceId", deviceId).catch(error => setErrorMessage(getHebrewErrorMessage(error, he.onboardingActionFailed)))} actions={actions} />}
        {phase === "needs_paste" && <PasteStep allowed={pasteAllowed} waiting={pasteWaiting} actions={actions} />}
        {phase === "needs_model" && <ModelDownloadStep settings={settings} progress={modelProgress} actions={actions} />}
      </div></div>
    </section></div>
  </div>;
}
