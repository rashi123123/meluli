import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { ShortcutEditor } from "@/components/ShortcutEditor";
import { SettingsView } from "@/features/settings/SettingsView";
import { AppContext, useAppContext, type AppContextValue } from "@/context/app-context";
import { appSettingsSchema } from "@shared/schemas";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { he } from "@shared/locale";

vi.mock("@/features/workspace/WorkspaceView", () => ({ WorkspaceView: function Workspace() {
  const { setActiveView } = useAppContext();
  return <button onClick={() => setActiveView("history")}>תמלול אחרון</button>;
} }));
vi.mock("@/features/history/HistoryPanel", () => ({ HistoryPanel: () => <div>תמלולים</div> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root, context: AppContextValue;
function fixture(): AppContextValue {
  const settings = appSettingsSchema.parse({ onboarding: { phase: "activated", surface: "workspace", activatedAt: 1, completedOptionalActions: ["recording_shortcut", "overlay_accessibility"], dismissedOptionalActions: [] } });
  settings.modelState.downloadState = "ready";
  return {
    loading: false, settings, appState: { status: "idle", timerStartedAt: null }, permissionStatus: "granted", accessibilityPermissionStatus: "granted",
    modelProgress: null, storagePaths: null, lastTranscript: null, onboarding: deriveOnboardingDisplayState(settings, "granted"),
    activeView: "workspace", setActiveView: vi.fn(), errorMessage: null, setErrorMessage: vi.fn(),
    recording: { isPreparing: false, mediaStream: null, beginHold: vi.fn(), endHold: vi.fn(), startRecording: vi.fn(), pauseRecording: vi.fn(), resumeRecording: vi.fn(), stopRecording: vi.fn(), abandonStart: vi.fn(), cancelRecording: vi.fn(), heldRecording: null, resendHeldRecording: vi.fn(), dropHeldRecording: vi.fn(), isResending: false, cancelProcessing: vi.fn(), interruptRecording: vi.fn() },
    transcripts: { latestTranscript: null, items: [], selectedId: null, selectedTranscript: null, searchQuery: "", setSearchQuery: vi.fn(), setSelectedId: vi.fn(), prependTranscript: vi.fn(), updateTranscript: vi.fn(), restoreTranscript: vi.fn(), deleteTranscript: vi.fn(), deleteAllTranscripts: vi.fn(), loadMore: vi.fn(), refresh: vi.fn(), hasMore: false, isLoading: false },
    refreshSettings: vi.fn(), updateSetting: vi.fn(), requestMicrophonePermission: vi.fn(), requestAccessibilityPermission: vi.fn(), downloadModel: vi.fn(), removeModel: vi.fn(), importAudio: vi.fn(), importDroppedAudio: vi.fn(), submitYouTubeUrl: vi.fn(), cancelActiveYouTube: vi.fn(), cancelPendingYouTube: vi.fn(), revealStorage: vi.fn(), rerunOnboarding: vi.fn(), resetEverything: vi.fn(), trackOnboardingStepViewed: vi.fn(), completeOnboardingStep: vi.fn(), continueOnboardingLater: vi.fn(), goBackOnboardingStep: vi.fn(), resumeOnboardingFlow: vi.fn(), dismissOnboardingOptionalAction: vi.fn()
  };
}
async function render(node: ReactNode) { await act(async () => root.render(<AppContext.Provider value={context}>{node}</AppContext.Provider>)); }
function byText(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!; }
function press(input: HTMLInputElement, key = "t") { return act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true })); }); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  context = fixture(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.assign(window, { ivritMenuBar: { permissions: { openMicrophoneSettings: vi.fn().mockResolvedValue(undefined), openAccessibilitySettings: vi.fn().mockResolvedValue(undefined) } } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shortcut keyboard and async recovery", () => {
  it("returns focus to the field when resetting a draft removes its actions", async () => {
    await render(<ShortcutEditor id="shortcut" label="קיצור" description="לחצו על קיצור חדש" value="Control+R" onSave={vi.fn()} />);
    const input = host.querySelector("input")!;
    expect(input.getAttribute("aria-describedby")).toBe("shortcut-description");
    await press(input);
    await act(async () => { byText(he.reset).focus(); byText(he.reset).click(); });
    expect(input.value).toBe("⌃R"); expect(document.activeElement).toBe(input);
    expect(byText(he.save)).toBeUndefined();
  });

  it("prevents duplicate saves and draft changes while saving without dropping focus", async () => {
    const pending = deferred(); const onSave = vi.fn(() => pending.promise);
    function Editor() {
      const [value, setValue] = useState("Control+R");
      return <ShortcutEditor id="shortcut" label="קיצור" description="שינוי" value={value} onSave={async next => { await onSave(); setValue(next); }} />;
    }
    await render(<Editor />); const input = host.querySelector("input")!; await press(input);
    const draft = input.value; const save = byText(he.save);
    await act(async () => { save.focus(); save.click(); save.click(); });
    expect(onSave).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(save);
    expect(save.getAttribute("aria-busy")).toBe("true");
    await press(input, "u"); expect(input.value).toBe(draft);
    await act(async () => pending.resolve());
    expect(document.activeElement).toBe(input); expect(byText(he.save)).toBeUndefined();
  });

  it("keeps failed shortcuts editable and links the recovery message to the focused field", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Could not register the global shortcut."));
    await render(<ShortcutEditor id="shortcut" label="קיצור" description="שינוי" value="Control+R" onSave={onSave} />);
    const input = host.querySelector("input")!; await press(input);
    await act(async () => { byText(he.save).focus(); byText(he.save).click(); });
    expect(document.activeElement).toBe(input); expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain("shortcut-error");
    expect(host.querySelector("#shortcut-error")?.textContent).toBe(he.shortcutRegisterFailed);
    await press(input, "u"); expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});

describe("settings recovery", () => {
  it.each([
    ["request ECONNRESET 10.0.0.1", he.modelDownloadFailed],
    ["Error invoking remote method 'model:download': Error: אין מספיק מקום במחשב.", "אין מספיק מקום במחשב."]
  ])("keeps localized model failure details and a retry available: %s", async (error, explanation) => {
    context.settings!.modelState.downloadState = "error";
    context.settings!.modelState.lastError = error;
    context.modelProgress = { percent: 50, bytesDownloaded: 50, totalBytes: 100 };
    await render(<SettingsView />);
    expect(host.textContent).toContain(explanation);
    expect(host.textContent).not.toContain("ECONNRESET");
    expect(host.textContent).not.toContain("model:download");
    expect(host.textContent).not.toContain("50%");
    await act(async () => byText(he.retry).click());
    expect(context.downloadModel).toHaveBeenCalledOnce();
  });

  it("focuses the safe reset choice, consumes Escape, and restores the trigger", async () => {
    await render(<SettingsView />);
    await act(async () => { byText("איפוס…").focus(); byText("איפוס…").click(); });
    expect(document.activeElement).toBe(byText(he.settingsResetCancel));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => byText(he.settingsResetCancel).dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true); expect(document.activeElement).toBe(byText("איפוס…"));
  });

  it("keeps reset confirmation pending, prevents duplicate mutation and retains recovery after failure", async () => {
    const pending = deferred(); context.resetEverything = vi.fn(() => pending.promise.then(() => { throw new Error("disk failure"); }));
    await render(<SettingsView />); await act(async () => byText("איפוס…").click());
    const confirm = byText(he.settingsResetConfirmButton);
    await act(async () => { confirm.focus(); confirm.click(); confirm.click(); });
    expect(context.resetEverything).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(confirm);
    await act(async () => byText(he.settingsResetCancel).click());
    expect(byText(he.settingsResetConfirmButton)).toBe(confirm);
    await act(async () => pending.resolve());
    expect(byText(he.settingsResetConfirmButton)).toBe(confirm); expect(confirm.getAttribute("aria-disabled")).toBe("false");
    expect(context.setErrorMessage).toHaveBeenCalledWith("הפעולה לא הושלמה. אפשר לנסות שוב.");
  });

  it("catches a refused microphone request and leaves its action ready to retry", async () => {
    context.permissionStatus = "unknown"; context.requestMicrophonePermission = vi.fn().mockRejectedValue(new Error(he.permissionNeeded));
    await render(<SettingsView />);
    const microphone = byText(he.allowMicrophone);
    await act(async () => microphone.click());
    expect(context.setErrorMessage).toHaveBeenCalledWith(he.permissionNeeded);
    expect(microphone.getAttribute("aria-disabled")).toBe("false");
  });

  it("sends a blocked microphone to the system settings instead of re-requesting", async () => {
    context.permissionStatus = "denied";
    const openMicrophoneSettings = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.ivritMenuBar, { permissions: { ...window.ivritMenuBar.permissions, openMicrophoneSettings } });
    await render(<SettingsView />);
    await act(async () => byText("פתיחת הגדרות המערכת").click());
    expect(openMicrophoneSettings).toHaveBeenCalledOnce(); expect(context.requestMicrophonePermission).not.toHaveBeenCalled();
  });

  it("reports failed setting writes and suppresses duplicate in-flight writes", async () => {
    const pending = deferred(); context.updateSetting = vi.fn(() => pending.promise.then(() => { throw new Error("write failed"); }));
    await render(<SettingsView />); const control = host.querySelector<HTMLElement>('[role="switch"]')!;
    await act(async () => { control.focus(); control.click(); control.click(); });
    expect(context.updateSetting).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(control);
    await act(async () => pending.resolve());
    expect(context.setErrorMessage).toHaveBeenCalledOnce(); expect(control.getAttribute("aria-disabled")).toBe("false");
  });
});

it("restores direct transcript navigation focus, updates route title, and exposes background recording", async () => {
  context.appState = { status: "recording", timerStartedAt: 1000 };
  function Harness() {
    const [view, setView] = useState(context.activeView);
    return <AppContext.Provider value={{ ...context, activeView: view, setActiveView: setView }}><App /></AppContext.Provider>;
  }
  await render(<Harness />); const origin = byText("תמלול אחרון");
  await act(async () => { origin.focus(); origin.click(); });
  expect(document.title).toBe(`${he.history} — מלולי`);
  expect(document.activeElement).toBe(host.querySelector(".desktop-toolbar h2"));
  expect(host.querySelector(".nav-operation-status")?.textContent).toBe(he.recording);
  expect([...host.querySelectorAll('[role="status"]')].some(status => status.textContent === he.recording)).toBe(true);
  expect(host.querySelector(".model-status")).toBeNull();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  expect(document.title).toBe("בית — מלולי"); expect(document.activeElement).toBe(origin);
  await act(async () => host.querySelector<HTMLAnchorElement>(".skip-link")!.click());
  expect(document.activeElement).toBe(host.querySelector("#main-content"));
});
