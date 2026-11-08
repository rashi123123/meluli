import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContextValue } from "@/context/app-context";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { appSettingsSchema } from "@shared/schemas";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { he } from "@shared/locale";
import type { OnboardingPhase } from "@shared/types";

type SetupContext = Pick<AppContextValue, "settings" | "permissionStatus" | "accessibilityPermissionStatus" | "onboarding" | "modelProgress" | "appState" | "recording" | "trackOnboardingStepViewed" | "completeOnboardingStep" | "continueOnboardingLater" | "goBackOnboardingStep" | "requestMicrophonePermission" | "requestAccessibilityPermission" | "downloadModel" | "setErrorMessage">;
type MicrophoneOptions = Parameters<typeof import("@/hooks/use-microphone-check").useMicrophoneCheck>[0];
type MicrophoneCheck = ReturnType<typeof import("@/hooks/use-microphone-check").useMicrophoneCheck>;
let context: SetupContext;
let microphone: MicrophoneCheck;
let microphoneOptions: MicrophoneOptions;
vi.mock("@/context/app-context", () => ({ useAppContext: () => context }));
vi.mock("@/hooks/use-microphone-check", () => ({ useMicrophoneCheck: (options: MicrophoneOptions) => { microphoneOptions = options; return microphone; } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let bridge: { accessibilityStatus: ReturnType<typeof vi.fn>; openAccessibilitySettings: ReturnType<typeof vi.fn> };
let host: HTMLDivElement;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setPhase(phase: OnboardingPhase) {
  context.settings!.onboarding.phase = phase;
  context.onboarding = deriveOnboardingDisplayState(context.settings!, context.permissionStatus);
}
async function render() { await act(async () => root.render(<OnboardingFlow />)); }
const primary = () => host.querySelector<HTMLButtonElement>('[data-onboarding-action="primary"]')!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const settings = appSettingsSchema.parse({ onboarding: { phase: "not_started", surface: "flow" } });
  settings.modelState.downloadState = "missing";
  context = {
    settings, permissionStatus: "not-determined", accessibilityPermissionStatus: "denied", onboarding: deriveOnboardingDisplayState(settings, "not-determined"), modelProgress: null,
    appState: { status: "idle", timerStartedAt: null },
    recording: { isPreparing: false, mediaStream: null, beginHold: vi.fn(), heldRecordingSaved: vi.fn(() => false), endHold: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), abandonStart: vi.fn(), pauseRecording: vi.fn(), resumeRecording: vi.fn(), cancelRecording: vi.fn(), heldRecording: null, resendHeldRecording: vi.fn(), dropHeldRecording: vi.fn(), isResending: false, cancelProcessing: vi.fn(), interruptRecording: vi.fn() },
    trackOnboardingStepViewed: vi.fn().mockResolvedValue(undefined), completeOnboardingStep: vi.fn().mockResolvedValue(undefined),
    continueOnboardingLater: vi.fn().mockResolvedValue(undefined), goBackOnboardingStep: vi.fn().mockResolvedValue(undefined),
    requestMicrophonePermission: vi.fn().mockResolvedValue("granted"), requestAccessibilityPermission: vi.fn().mockResolvedValue("denied"), downloadModel: vi.fn().mockResolvedValue(undefined), setErrorMessage: vi.fn()
  };
  bridge = { accessibilityStatus: vi.fn().mockResolvedValue("denied"), openAccessibilitySettings: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("ivritMenuBar", { permissions: bridge });
  let checking = false;
  // Like the real hook, a start while one is pending does nothing.
  microphone = { status: "idle", level: 0, error: null, hasDetected: false, start: vi.fn(async () => { if (checking) return; checking = true; try { await microphoneOptions.onRequestPermission(); } finally { checking = false; } }), stop: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("onboarding navigation", () => {
  it("starts the download from the welcome step and moves on without waiting for it", async () => {
    setPhase("not_started");
    const download = deferred();
    vi.mocked(context.downloadModel).mockReturnValue(download.promise);
    await render();
    await act(async () => { primary().click(); primary().click(); });
    expect(context.downloadModel).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).toHaveBeenCalledWith("ready");
    await act(async () => download.resolve());
  });

  it.each(["ready", "downloading"] as const)("does not download again from the welcome step when the engine is %s", async state => {
    setPhase("not_started"); context.settings!.modelState.downloadState = state;
    await render(); await act(async () => primary().click());
    expect(context.downloadModel).not.toHaveBeenCalled();
    expect(context.completeOnboardingStep).toHaveBeenCalledWith("ready");
  });

  it("asks for microphone permission once on arrival without advancing the step or losing focus", async () => {
    setPhase("needs_mic");
    const permission = deferred();
    vi.mocked(context.requestMicrophonePermission).mockImplementation(() => permission.promise.then(() => "granted"));
    await render();
    primary().focus();
    await act(async () => { primary().click(); primary().click(); });
    expect(context.requestMicrophonePermission).toHaveBeenCalledOnce();
    expect(context.requestMicrophonePermission).toHaveBeenCalledWith({ advanceOnboarding: false });
    expect(document.activeElement).toBe(primary());
    await act(async () => permission.resolve());
    expect(context.completeOnboardingStep).not.toHaveBeenCalled();
    await act(async () => button(he.onboardingNotNow).click());
    expect(context.continueOnboardingLater).toHaveBeenCalledOnce();
  });

  it("serializes a back transition with simultaneous primary and skip activations", async () => {
    setPhase("needs_mic");
    const back = deferred();
    vi.mocked(context.goBackOnboardingStep).mockReturnValue(back.promise);
    await render();
    await act(async () => { button(he.back).click(); primary().click(); button(he.onboardingNotNow).click(); });
    expect(context.goBackOnboardingStep).toHaveBeenCalledOnce();
    expect(context.requestMicrophonePermission).toHaveBeenCalledOnce();
    expect(context.continueOnboardingLater).not.toHaveBeenCalled();
    await act(async () => back.resolve());
    await act(async () => primary().click());
    expect(context.requestMicrophonePermission).toHaveBeenCalledTimes(2);
  });

  it("hands off to Home immediately while the download remains unresolved and guards repeated actions", async () => {
    context.permissionStatus = "granted"; setPhase("needs_model");
    const download = deferred();
    const navigation = deferred();
    vi.mocked(context.downloadModel).mockReturnValue(download.promise);
    vi.mocked(context.continueOnboardingLater).mockReturnValue(navigation.promise);
    await render();
    await act(async () => { primary().click(); primary().click(); button(he.onboardingContinueLater).click(); });
    expect(context.downloadModel).toHaveBeenCalledOnce();
    expect(context.continueOnboardingLater).toHaveBeenCalledWith("local_install");
    expect(context.continueOnboardingLater).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).not.toHaveBeenCalled();
    await act(async () => navigation.resolve());
    await act(async () => root.render(null));
    // Completion belongs to the provider; this view must not navigate again.
    await act(async () => download.resolve());
    expect(context.continueOnboardingLater).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).not.toHaveBeenCalled();
  });

  it("leaves a background download failure to the status card after setup unmounts", async () => {
    context.permissionStatus = "granted"; setPhase("needs_model");
    const download = deferred(); vi.mocked(context.downloadModel).mockReturnValue(download.promise);
    await render(); await act(async () => primary().click());
    expect(context.continueOnboardingLater).toHaveBeenCalledWith("local_install");
    await act(async () => root.render(null));
    await act(async () => download.reject(new Error("Network failure")));
    expect(context.setErrorMessage).not.toHaveBeenCalled();
  });

  it("leaves an existing background download running when continuing Home", async () => {
    context.permissionStatus = "granted"; setPhase("needs_model");
    context.settings!.modelState.downloadState = "downloading";
    await render();
    expect(primary().textContent).toBe("למסך הבית");
    await act(async () => primary().click());
    expect(context.downloadModel).not.toHaveBeenCalled();
    expect(context.continueOnboardingLater).toHaveBeenCalledWith("local_install");
    expect(context.completeOnboardingStep).not.toHaveBeenCalled();
  });

  it("finishes ready setup without downloading again or fabricating a transcript", async () => {
    context.permissionStatus = "granted";
    context.settings!.modelState.downloadState = "ready"; setPhase("needs_model");
    await render(); await act(async () => primary().click());
    expect(context.completeOnboardingStep).toHaveBeenCalledWith("local_install");
    expect(context.downloadModel).not.toHaveBeenCalled();
    expect(context.continueOnboardingLater).not.toHaveBeenCalled();
    expect(context.recording.startRecording).not.toHaveBeenCalled();
  });

  it.each(["listening", "detected"] as const)("stops the %s microphone check before completing the microphone step", async status => {
    context.permissionStatus = "granted"; setPhase("needs_mic"); microphone.status = status;
    await render(); await act(async () => { primary().click(); primary().click(); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).toHaveBeenCalledWith("microphone");
    expect(vi.mocked(microphone.stop).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(context.completeOnboardingStep).mock.invocationCallOrder[0]);
    expect(context.recording.startRecording).not.toHaveBeenCalled();
  });

  it("still checks the microphone when permission was already granted", async () => {
    context.permissionStatus = "granted"; setPhase("needs_mic");
    await render();
    expect(microphone.start).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).not.toHaveBeenCalled();
    expect(context.requestMicrophonePermission).toHaveBeenCalledWith({ advanceOnboarding: false });
  });

  it("does not reopen the microphone after the user continues", async () => {
    context.permissionStatus = "granted"; setPhase("needs_mic"); microphone.status = "listening";
    await render();
    await act(async () => primary().click());
    microphone.status = "idle"; await render();
    expect(context.completeOnboardingStep).toHaveBeenCalledWith("microphone");
    expect(microphone.start).not.toHaveBeenCalled();
  });

  it("waits for an active recorder before running the check", async () => {
    context.permissionStatus = "granted"; setPhase("needs_mic"); context.appState.status = "recording";
    await render();
    expect(microphone.start).not.toHaveBeenCalled();
    context.appState.status = "idle"; await render();
    expect(microphone.start).toHaveBeenCalledOnce();
  });

  it("disables the check when leaving its step or yielding to an active recorder", async () => {
    setPhase("needs_mic"); await render(); expect(microphoneOptions.enabled).toBe(true);
    context.appState.status = "recording"; await render(); expect(microphoneOptions.enabled).toBe(false);
    context.appState.status = "idle"; context.recording.isPreparing = true;
    await render(); expect(microphoneOptions.enabled).toBe(false);
    context.recording.isPreparing = false;
    await render(); expect(microphoneOptions.enabled).toBe(true);
    await act(async () => button(he.back).click());
    expect(context.goBackOnboardingStep).toHaveBeenCalledOnce();
    setPhase("not_started"); await render(); expect(microphoneOptions.enabled).toBe(false);
  });

  it("focuses only a changed step heading and does not steal focus on progress updates", async () => {
    await render(); primary().focus();
    setPhase("needs_mic"); await render();
    const heading = host.querySelector<HTMLHeadingElement>("[data-onboarding-heading]")!;
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);
    button(he.onboardingNotNow).focus();
    context.modelProgress = { percent: 20, bytesDownloaded: 20, totalBytes: 100 };
    await render();
    expect(document.activeElement).toBe(button(he.onboardingNotNow));
    context.permissionStatus = "granted"; setPhase("needs_model"); await render();
    expect(document.activeElement).toBe(host.querySelector("[data-onboarding-heading]"));
    expect(context.trackOnboardingStepViewed).toHaveBeenCalledTimes(3);
  });

  it("reports a tracking failure without an unhandled rejection", async () => {
    vi.mocked(context.trackOnboardingStepViewed).mockRejectedValue(new Error("שמירת ההתקדמות נכשלה"));
    await render();
    expect(context.setErrorMessage).toHaveBeenCalledWith("שמירת ההתקדמות נכשלה");
    expect(primary().disabled).toBe(false);
  });
});

describe("paste permission step", () => {
  it("asks for Accessibility, waits for System Settings and finishes once it is granted", async () => {
    vi.useFakeTimers();
    try {
      context.permissionStatus = "granted"; setPhase("needs_paste");
      await render();
      expect(primary().textContent).toBe(he.onboardingPasteAction);
      await act(async () => primary().click());
      expect(context.requestAccessibilityPermission).toHaveBeenCalledOnce();
      expect(host.textContent).toContain(he.onboardingPasteWaiting);
      expect(primary().textContent).toBe(he.onboardingPasteOpenSettings);
      await act(async () => primary().click());
      expect(bridge.openAccessibilitySettings).toHaveBeenCalledOnce();
      expect(context.requestAccessibilityPermission).toHaveBeenCalledOnce();
      bridge.accessibilityStatus.mockResolvedValue("granted");
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(host.textContent).toContain(he.onboardingPasteAllowed);
      expect(primary().textContent).toBe(he.continue);
      await act(async () => primary().click());
      expect(context.completeOnboardingStep).toHaveBeenCalledWith("paste");
    } finally { vi.useRealTimers(); }
  });

  it("continues at once when macOS grants Accessibility from the prompt", async () => {
    context.permissionStatus = "granted"; setPhase("needs_paste");
    vi.mocked(context.requestAccessibilityPermission).mockResolvedValue("granted");
    await render(); await act(async () => primary().click());
    expect(host.textContent).toContain(he.onboardingPasteAllowed);
    expect(bridge.accessibilityStatus).not.toHaveBeenCalled();
  });

  it("records Not Now as a declined step and moves on without asking", async () => {
    context.permissionStatus = "granted"; setPhase("needs_paste");
    await render(); await act(async () => button(he.onboardingNotNow).click());
    expect(context.completeOnboardingStep).toHaveBeenCalledWith("paste", { declined: true });
    expect(context.requestAccessibilityPermission).not.toHaveBeenCalled();
  });

  it("says how to allow paste and what Not Now leaves", async () => {
    context.permissionStatus = "granted"; setPhase("needs_paste");
    await render();
    expect(host.querySelector(".paste-how")?.textContent).toBe(he.onboardingPasteHow);
    expect(host.querySelector(".onboarding-note")?.textContent).toBe(he.onboardingPasteWithout);
  });
});
