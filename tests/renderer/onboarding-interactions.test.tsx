import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContextValue } from "@/context/app-context";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { appSettingsSchema } from "@shared/schemas";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { he } from "@shared/locale";
import type { OnboardingPhase } from "@shared/types";

type SetupContext = Pick<AppContextValue, "settings" | "permissionStatus" | "onboarding" | "modelProgress" | "appState" | "recording" | "trackOnboardingStepViewed" | "completeOnboardingStep" | "continueOnboardingLater" | "goBackOnboardingStep" | "requestMicrophonePermission" | "downloadModel" | "setErrorMessage">;
type MicrophoneOptions = Parameters<typeof import("@/hooks/use-microphone-check").useMicrophoneCheck>[0];
type MicrophoneCheck = ReturnType<typeof import("@/hooks/use-microphone-check").useMicrophoneCheck>;
let context: SetupContext;
let microphone: MicrophoneCheck;
let microphoneOptions: MicrophoneOptions;
vi.mock("@/context/app-context", () => ({ useAppContext: () => context }));
vi.mock("@/hooks/use-microphone-check", () => ({ useMicrophoneCheck: (options: MicrophoneOptions) => { microphoneOptions = options; return microphone; } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
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
    settings, permissionStatus: "not-determined", onboarding: deriveOnboardingDisplayState(settings, "not-determined"), modelProgress: null,
    appState: { status: "idle", timerStartedAt: null },
    recording: { isPreparing: false, mediaStream: null, isOwner: false, beginHold: vi.fn(), endHold: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), abandonStart: vi.fn(), pauseRecording: vi.fn(), resumeRecording: vi.fn(), cancelRecording: vi.fn(), heldRecording: null, resendHeldRecording: vi.fn(), dropHeldRecording: vi.fn(), isResending: false, cancelProcessing: vi.fn(), interruptRecording: vi.fn() },
    trackOnboardingStepViewed: vi.fn().mockResolvedValue(undefined), completeOnboardingStep: vi.fn().mockResolvedValue(undefined),
    continueOnboardingLater: vi.fn().mockResolvedValue(undefined), goBackOnboardingStep: vi.fn().mockResolvedValue(undefined),
    requestMicrophonePermission: vi.fn().mockResolvedValue("granted"), downloadModel: vi.fn().mockResolvedValue(undefined), setErrorMessage: vi.fn()
  };
  let checking = false;
  // Like the real hook, a start while one is pending does nothing.
  microphone = { status: "idle", level: 0, error: null, hasDetected: false, start: vi.fn(async () => { if (checking) return; checking = true; try { await microphoneOptions.onRequestPermission(); } finally { checking = false; } }), stop: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
describe("hold key step", () => {
  let pressed: (value: boolean) => void;
  let permissions: { requestHoldKey: ReturnType<typeof vi.fn>; openHoldKeySettings: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    pressed = () => {};
    permissions = { requestHoldKey: vi.fn().mockResolvedValue("needs_permission"), openHoldKeySettings: vi.fn().mockResolvedValue(true) };
    Object.assign(window, { ivritMenuBar: { permissions, app: { onHoldKeyPressed: (listener: (value: boolean) => void) => { pressed = listener; return () => {}; } } } });
    context.permissionStatus = "granted"; setPhase("needs_hold_key");
  });
  const setStatus = (status: "off" | "needs_permission" | "ready" | "unavailable") => { context.appState = { ...context.appState!, holdKey: { status } }; };

  it("asks macOS once, then lets setup move on without the permission", async () => {
    setStatus("needs_permission"); await render();
    expect(primary().textContent).toContain(he.holdKeyAllow);
    await act(async () => primary().click());
    expect(permissions.requestHoldKey).toHaveBeenCalledOnce();
    expect(context.completeOnboardingStep).not.toHaveBeenCalled();
    await act(async () => button(he.holdKeyOpenSettings).click());
    expect(permissions.openHoldKeySettings).toHaveBeenCalledOnce();
    await act(async () => primary().click());
    expect(context.completeOnboardingStep).toHaveBeenCalledWith("hold_key");
    expect(permissions.requestHoldKey).toHaveBeenCalledOnce();
  });
  it("proves the key from a real press", async () => {
    setStatus("ready"); await render();
    expect(host.textContent).toContain(he.holdKeyTryIt);
    await act(async () => pressed(true));
    await act(async () => pressed(false));
    expect(host.textContent).toContain(he.holdKeyWorks);
  });
  it("never blocks setup on a key that is off or cannot run", async () => {
    context.settings!.holdKey = "off"; setStatus("needs_permission"); await render();
    expect(primary().textContent).toContain(he.continue);
    expect(host.textContent).toContain(he.holdKeyOffMessage);
    context.settings!.holdKey = "right_command"; setStatus("unavailable"); await render();
    expect(primary().textContent).toContain(he.continue);
    expect(host.textContent).toContain(he.holdKeyUnavailable);
  });
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("onboarding navigation", () => {
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
    await act(async () => button(he.onboardingContinueLater).click());
    expect(context.continueOnboardingLater).toHaveBeenCalledOnce();
  });

  it("serializes a back transition with simultaneous primary and skip activations", async () => {
    setPhase("needs_mic");
    const back = deferred();
    vi.mocked(context.goBackOnboardingStep).mockReturnValue(back.promise);
    await render();
    await act(async () => { button(he.back).click(); primary().click(); button(he.onboardingContinueLater).click(); });
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

  it("does not reopen the microphone after the user stops the check or continues", async () => {
    context.permissionStatus = "granted"; setPhase("needs_mic"); microphone.status = "listening";
    await render();
    await act(async () => button("עצירת הבדיקה").click());
    microphone.status = "idle"; await render();
    expect(microphone.start).not.toHaveBeenCalled();
    microphone.status = "listening"; await render();
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
    button(he.onboardingContinueLater).focus();
    context.modelProgress = { percent: 20, bytesDownloaded: 20, totalBytes: 100 };
    await render();
    expect(document.activeElement).toBe(button(he.onboardingContinueLater));
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
