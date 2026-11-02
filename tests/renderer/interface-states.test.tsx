import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "@/context/app-context";
import { OverlayContext } from "@/context/overlay-context";
import { appSettingsSchema } from "@shared/schemas";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { FileDropCell } from "@/features/workspace/FileDropCell";
import { SupportedSitesInfo } from "@/features/workspace/SupportedSitesInfo";
import { OverlayPositionPicker } from "@/features/settings/OverlayPositionPicker";
import { SUPPORTED_SITES_URL } from "@shared/constants";
import { YouTubeInputRow } from "@/features/workspace/YouTubeInputRow";
import { RecordingArea } from "@/features/workspace/RecordingArea";
import { TranscriptDocument } from "@/features/transcript/TranscriptDocument";
import { RecentTranscripts } from "@/features/workspace/RecentTranscripts";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { ShortcutEditor } from "@/components/ShortcutEditor";
import { CopyButton } from "@/components/CopyButton";
import { BarVisualizer } from "@/components/ui/bar-visualizer";
import App from "@/App";
import { SettingsView } from "@/features/settings/SettingsView";
import { ModelDownloadStep } from "@/features/onboarding/ModelDownloadStep";
import { MicrophoneStep } from "@/features/onboarding/MicrophoneStep";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { FloatingRecorderHud } from "@/features/overlay/FloatingRecorderHud";
import { WorkspaceView } from "@/features/workspace/WorkspaceView";
import { SearchInput } from "@/components/SearchInput";
import { InfoPage } from "@/features/info/InfoPage";
import { he } from "@shared/locale";
import type { AppRuntimeStatus, TranscriptRecord } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root, context: AppContextValue;
let reduced = false;
let cancelKey: () => void = () => {};
let holdKey: (phase: "press" | "release") => void = () => {};
const transcript: TranscriptRecord = { id: "test", text: "תמלול לבדיקה", createdAt: 1000, sourceType: "microphone" };
function fixture(): AppContextValue {
  const settings = appSettingsSchema.parse({ onboarding: { phase: "activated", surface: "workspace", activatedAt: 1, completedOptionalActions: ["recording_shortcut", "overlay_accessibility"], dismissedOptionalActions: [] } });
  settings.modelState.downloadState = "ready";
  return {
    loading: false, settings, appState: { status: "idle", timerStartedAt: null }, permissionStatus: "granted", accessibilityPermissionStatus: "granted",
    modelProgress: null, storagePaths: null, lastTranscript: transcript, onboarding: deriveOnboardingDisplayState(settings, "granted"),
    activeView: "workspace", setActiveView: vi.fn(), errorMessage: null, setErrorMessage: vi.fn(),
    recording: { isPreparing: false, mediaStream: null, beginHold: vi.fn(), endHold: vi.fn(), startRecording: vi.fn(), pauseRecording: vi.fn(), resumeRecording: vi.fn(), stopRecording: vi.fn(), abandonStart: vi.fn().mockResolvedValue(false), cancelRecording: vi.fn(), heldRecording: null, resendHeldRecording: vi.fn(), dropHeldRecording: vi.fn(), isResending: false, cancelProcessing: vi.fn(), interruptRecording: vi.fn() },
    transcripts: { latestTranscript: transcript, items: [], selectedId: null, selectedTranscript: null, searchQuery: "", setSearchQuery: vi.fn(), setSelectedId: vi.fn(), prependTranscript: vi.fn(), updateTranscript: vi.fn(), restoreTranscript: vi.fn(), deleteTranscript: vi.fn(), deleteAllTranscripts: vi.fn(), loadMore: vi.fn(), refresh: vi.fn(), hasMore: false, isLoading: false },
    refreshSettings: vi.fn(), updateSetting: vi.fn(), requestMicrophonePermission: vi.fn(), requestAccessibilityPermission: vi.fn(), downloadModel: vi.fn(), removeModel: vi.fn(), importAudio: vi.fn(), importDroppedAudio: vi.fn(), submitYouTubeUrl: vi.fn(), cancelActiveYouTube: vi.fn(), cancelPendingYouTube: vi.fn(), revealStorage: vi.fn(), rerunOnboarding: vi.fn(), resetEverything: vi.fn(), trackOnboardingStepViewed: vi.fn().mockResolvedValue(undefined), completeOnboardingStep: vi.fn(), continueOnboardingLater: vi.fn(), goBackOnboardingStep: vi.fn(), resumeOnboardingFlow: vi.fn(), dismissOnboardingOptionalAction: vi.fn()
  };
}
async function render(node: ReactNode) { await act(async () => root.render(<AppContext.Provider value={context}><OverlayContext.Provider value={context}>{node}</OverlayContext.Provider></AppContext.Provider>)); }
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label) ?? null as unknown as HTMLButtonElement;
const unavailable = (item: Element) => item.getAttribute("aria-disabled") === "true";
beforeEach(() => {
  reduced = false; context = fixture(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.assign(window, { ivritMenuBar: { transcription: { cancel: vi.fn() }, files: { exportTranscriptSrt: vi.fn(), openExternal: vi.fn() }, overlay: { open: vi.fn() }, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } } });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("real recorder states and actions", () => {
  it.each([
    ["idle", "startRecording", he.startRecording, false],
    ["recording", "stopRecording", he.stopRecording, true],
    ["paused", "stopRecording", he.stopRecording, true],
    ["processing", "cancel", he.processingCancel, false],
    ["youtube_downloading", "youtube", he.processingCancel, false],
    ["error", "startRecording", he.startRecording, false]
  ] as const)("%s exposes its current action immediately", async (status, action, label, canPause) => {
    context.appState = { status: status as AppRuntimeStatus, timerStartedAt: status === "recording" ? Date.now() - 1000 : 1000, activeSourceType: status === "youtube_downloading" ? "youtube" : "microphone" };
    await render(<RecordingArea />);
    expect(button(label)).toBeTruthy();
    const pause = button(status === "paused" ? he.resumeRecording : he.pauseRecording);
    if (canPause) expect(unavailable(pause)).toBe(false);
    else if (pause) expect(unavailable(pause)).toBe(true);
    await act(async () => button(label).click());
    if (action === "cancel") expect(window.ivritMenuBar.transcription.cancel).toHaveBeenCalledOnce();
    else if (action === "youtube") expect(context.cancelActiveYouTube).toHaveBeenCalledOnce();
    else expect(context.recording[action]).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="status"]')?.textContent).not.toMatch(/\d+:\d+/);
  });
  it("routes YouTube processing cancellation to the queue owner", async () => {
    context.appState = { status: "processing", timerStartedAt: null, activeSourceType: "youtube" };
    await render(<RecordingArea />); await act(async () => button(he.processingCancel).click());
    expect(context.cancelActiveYouTube).toHaveBeenCalledOnce(); expect(window.ivritMenuBar.transcription.cancel).not.toHaveBeenCalled();
  });
  it("lets the screen glow as ready only when recording can actually start", async () => {
    const tone = () => host.querySelector(".device")?.getAttribute("data-tone");
    await render(<RecordingArea />);
    expect(tone()).toBe("ok");
    context.recording.isPreparing = true; await render(<RecordingArea />);
    expect(tone()).toBeNull();
    context.recording.isPreparing = false; context.permissionStatus = "denied"; await render(<RecordingArea />);
    expect(tone()).toBe("alert");
    context.permissionStatus = "granted"; context.settings!.modelState.downloadState = "downloading"; await render(<RecordingArea />);
    expect(tone()).toBeNull();
  });
  it("prevents a second start while microphone preparation is pending", async () => {
    context.recording.isPreparing = true; await render(<RecordingArea />);
    expect(unavailable(button(he.startRecording))).toBe(true);
  });
  it("keeps focus on a control that becomes unavailable while the microphone opens", async () => {
    await render(<RecordingArea />);
    const start = button(he.startRecording); start.focus();
    context.recording.isPreparing = true; await render(<RecordingArea />);
    expect(button(he.startRecording)).toBe(start);
    expect(start.disabled).toBe(false); expect(unavailable(start)).toBe(true);
    await act(async () => start.click());
    expect(context.recording.startRecording).not.toHaveBeenCalled();
  });
  it("moves focus to the transport control when cancelling removes the focused button", async () => {
    context.appState = { status: "recording", timerStartedAt: 1000, activeSourceType: "microphone" };
    await render(<RecordingArea />);
    const stop = button(he.stopRecording);
    await act(async () => button("ביטול ההקלטה").click());
    expect(context.recording.cancelRecording).toHaveBeenCalledOnce();
    context.appState = { status: "idle", timerStartedAt: null };
    await render(<RecordingArea />);
    expect(document.activeElement).toBe(stop); expect(stop.getAttribute("aria-label")).toBe(he.startRecording);
  });
});

it("keeps history loading distinct from empty and disables duplicate pagination", async () => {
  context.transcripts.isLoading = true; context.transcripts.hasMore = true;
  await render(<HistoryPanel />);
  expect(host.textContent).toContain(he.loadingContent); expect(host.textContent).not.toContain(he.historyEmpty);
  const load = [...host.querySelectorAll("button")].find(b => b.textContent === he.loadMore)!;
  expect(unavailable(load)).toBe(true);
  context.transcripts.isLoading = false; context.transcripts.searchQuery = "לא קיים";
  await render(<HistoryPanel />); expect(host.textContent).toContain("לא נמצאו תמלולים");
});

it("exports SRT only for a transcript with timed segments and keeps source actions", async () => {
  await render(<TranscriptDocument transcript={transcript} />); expect(host.textContent).not.toContain(he.downloadSrt);
  await render(<TranscriptDocument transcript={{ ...transcript, sourceType: "youtube", sourceUrl: "https://youtu.be/test", segments: [{ start: 0, end: 1, text: "תמלול" }] }} />);
  expect(host.textContent).toContain(he.downloadSrt); expect(button(he.openOriginal)).toBeTruthy();
});

it("allows Tab out of shortcut capture and Escape restores the saved value", async () => {
  await render(<ShortcutEditor id="shortcut" label="קיצור" description="שינוי" value="Control+R" onSave={vi.fn()} />);
  const input = host.querySelector("input")!;
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(tab)); expect(tab.defaultPrevented).toBe(false);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(input.value).not.toBe("⌃R");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(input.value).toBe("⌃R");
});

it("keeps copy rejection actionable and clears confirmation when the transcript changes", async () => {
  vi.mocked(window.ivritMenuBar.clipboard.writeText).mockRejectedValueOnce(new Error("Denied"));
  await render(<CopyButton text="אחד" />); await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("button")?.getAttribute("aria-label")).toContain("לא הצליחה");
  await render(<CopyButton text="שניים" />); expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(he.copy);
});

it.each(["idle", "listening"] as const)("%s meter does not open an audio analyser", async state => {
  const create = vi.fn(); vi.stubGlobal("AudioContext", create);
  await render(<BarVisualizer state={state} mediaStream={{} as MediaStream} />);
  expect(create).not.toHaveBeenCalled(); expect(host.querySelectorAll(".audio-meter > span").length).toBe(15);
});

it("preserves the workspace DOM while settings and history are opened", async () => {
  function Harness() {
    const [view, setView] = useState(context.activeView);
    return <AppContext.Provider value={{ ...context, activeView: view, setActiveView: setView }}><App /></AppContext.Provider>;
  }
  await render(<Harness />); const workspace = host.querySelector(".workspace-stack");
  await act(async () => button(he.settings).click());
  expect(host.querySelector(".workspace-stack")).toBe(workspace);
  expect(workspace?.parentElement?.hidden).toBe(true);
  expect(button(he.settings).getAttribute("aria-current")).toBe("page");
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => button(he.history).click());
  expect(host.querySelector(".workspace-stack")).toBe(workspace);
  expect(button(he.history).getAttribute("aria-current")).toBe("page");
  await act(async () => button("בית").click());
  expect(workspace?.parentElement?.hidden).toBe(false);
});

it("opens the actual record selected from the home grid in history", async () => {
  context.transcripts.items = [transcript, { ...transcript, id: "file", sourceType: "imported_file", importedFileName: "ראיון.wav" }];
  await render(<RecentTranscripts />);
  const cards = host.querySelectorAll<HTMLButtonElement>(".transcript-preview");
  expect(cards).toHaveLength(2);
  await act(async () => cards[1].click());
  expect(context.transcripts.setSelectedId).toHaveBeenCalledWith("file");
  expect(context.setActiveView).toHaveBeenCalledWith("history");
});

it("home search reports no matches separately from a fresh history", async () => {
  context.transcripts.searchQuery = "לא קיים";
  await render(<RecentTranscripts />);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("לא נמצאו תמלולים לחיפוש הזה.");
});


describe("setup component states", () => {
  it.each(["missing", "downloading", "ready", "error"] as const)("model %s has truthful progress and actions", async state => {
    context.settings!.modelState.downloadState = state;
    await render(<ModelDownloadStep settings={context.settings!} progress={state === "downloading" ? { percent: 0, bytesDownloaded: 0, totalBytes: 100 } : null} />);
    expect(Boolean(host.querySelector('[role="progressbar"]'))).toBe(state === "downloading");
    if (state === "downloading") expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
    await render(<SettingsView />);
    const download = [...host.querySelectorAll("button")].find(b => b.textContent === he.retry || b.textContent === he.downloadHebrewModel);
    expect(Boolean(download)).toBe(state === "error" || state === "missing");
    if (download) expect(download.textContent).toBe(state === "error" ? he.retry : he.downloadHebrewModel);
    if (state === "error") expect(host.textContent).toContain(he.modelDownloadFailed);
  });
  it.each(["granted", "denied", "not-determined", "restricted", "unknown"] as const)("microphone permission %s remains readable", async permissionStatus => {
    await render(<MicrophoneStep permissionStatus={permissionStatus} />);
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(permissionStatus === "granted" ? "המיקרופון מאושר. נבדוק ששומעים." : he.permissionNeeded);
    expect(host.querySelector('[role="status"]')?.textContent).not.toBe("המיקרופון עובד");
  });
  it.each([
    ["requesting", 0, "פותחים את המיקרופון…"],
    ["listening", 0.25, "אפשר להגיד כמה מילים"],
    ["detected", 0.5, "המיקרופון עובד"]
  ] as const)("microphone %s shows its actual check state and measured level", async (status, level, message) => {
    const stop = vi.fn();
    await render(<MicrophoneStep permissionStatus="granted" status={status} level={level} onStop={stop} />);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(message);
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe(String(level * 100));
    const stopButton = [...host.querySelectorAll("button")].find(node => node.textContent === "עצירת הבדיקה");
    if (status === "requesting") expect(stopButton).toBeUndefined();
    else { await act(async () => stopButton!.click()); expect(stop).toHaveBeenCalledOnce(); }
  });
  it("keeps microphone check failure readable beside the meter", async () => {
    await render(<MicrophoneStep permissionStatus="granted" status="error" error="המיקרופון נותק. חברו אותו ונסו שוב." />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("המיקרופון נותק. חברו אותו ונסו שוב.");
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
  });
  it.each(["not_started", "needs_mic", "needs_model"] as const)("onboarding %s keeps its actions available", async phase => {
    context.settings!.onboarding.phase = phase;
    context.settings!.onboarding.surface = "flow";
    context.permissionStatus = phase === "needs_mic" ? "denied" : "granted";
    context.settings!.modelState.downloadState = "missing";
    context.onboarding = deriveOnboardingDisplayState(context.settings!, context.permissionStatus);
    await render(<OnboardingFlow />);
    const action = host.querySelector<HTMLButtonElement>('.onboarding-copy [data-onboarding-action="primary"]');
    expect(action?.textContent).toBe(phase === "not_started" ? he.onboardingStartSetup : phase === "needs_mic" ? he.onboardingMicrophoneAction : he.onboardingInstallAction);
    expect(host.querySelector(".onboarding-step-details")).toBeTruthy();
    expect(document.activeElement).toBe(host.querySelector("[data-onboarding-heading]"));
    expect(host.querySelector(".animate-in")).toBeNull();
  });
  it("keeps settings hook order stable as bootstrap finishes", async () => {
    const settings = context.settings; context.settings = null; await render(<SettingsView />);
    context.settings = settings; await render(<SettingsView />); expect(host.querySelector("select")).toBeTruthy();
  });
  it.each([["recording-shortcut-editor", "shortcut"], ["overlay-shortcut-editor", "overlayShortcut"]] as const)("%s saves through the shared settings update", async (id, key) => {
    await render(<SettingsView />);
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true, bubbles: true })); });
    const row = input.closest(".settings-row")!;
    const save = [...row.querySelectorAll("button")].find((item) => item.textContent === he.save)!;
    await act(async () => { save.click(); });
    expect(context.updateSetting).toHaveBeenCalledExactlyOnceWith(key, expect.stringContaining("K"));
  });
});

describe("floating recorder presentation states", () => {
  beforeEach(() => {
    Object.assign(window.ivritMenuBar, {
      app: { onRecordingToggleRequested: () => () => {}, onRecordingHoldRequested: (listener: (phase: "press" | "release") => void) => { holdKey = listener; return () => {}; }, onRecordingCancelRequested: (listener: () => void) => { cancelKey = listener; return () => {}; }, onRecordingUndoRequested: () => () => {}, onRecordingInterruptRequested: () => () => {} },
      overlay: { ready: vi.fn(), hide: vi.fn(), setSize: vi.fn(), onSnapPreview: () => () => {} },
      textInsert: { intoFocusedField: vi.fn() }
    });
  });
  it.each(["idle", "recording", "paused", "processing", "youtube_downloading", "error"] as const)("%s presents controls without waiting for an exit", async status => {
    context.appState = { status, timerStartedAt: status === "paused" ? 12_000 : Date.now(), activeSourceType: "microphone" };
    await render(<FloatingRecorderHud />);
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    const label = status === "recording" || status === "paused" ? he.stopRecording : status === "processing" ? he.processingCancel : he.startRecording;
    expect(button(label)).toBeTruthy();
  });
  it.each(["permission", "target_unavailable", "clipboard_unavailable", "paste_failed"] as const)("%s recovery retains copy and retry", async lastErrorCode => {
    context.appState.overlaySession = { id: "recovery", phase: "paste_failed", transcriptId: "test", transcriptText: "טקסט שנשמר", targetAppName: null, lastErrorCode };
    context.accessibilityPermissionStatus = "denied";
    await render(<FloatingRecorderHud />);
    expect(button(he.copy)).toBeTruthy();
    expect(button(lastErrorCode === "permission" ? he.allowAccessibility : he.retry)).toBeTruthy();
    expect(button(he.close)).toBeTruthy(); expect(button(he.startRecording)).toBeNull();
    expect(window.ivritMenuBar.overlay.setSize).toHaveBeenLastCalledWith("expanded");
  });
  it("offers undo and keeps the window up when a cancelled recording was kept", async () => {
    context.appState = { status: "recording", timerStartedAt: Date.now(), activeSourceType: "microphone" };
    context.recording.cancelRecording = vi.fn().mockResolvedValue(true);
    await render(<FloatingRecorderHud />);
    await act(async () => cancelKey());
    expect(window.ivritMenuBar.overlay.hide).not.toHaveBeenCalled();
    context.appState = { status: "idle", timerStartedAt: null };
    context.recording.heldRecording = { reason: "canceled", durationMs: 8_000 };
    context.recording.resendHeldRecording = vi.fn().mockResolvedValue(undefined);
    await render(<FloatingRecorderHud />);
    expect(host.textContent).toContain(he.recordingCanceled);
    await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === he.undoWithShortcut)!.click());
    expect(context.recording.resendHeldRecording).toHaveBeenCalledOnce();
  });
  it("closes straight away when a cancelled recording was too short to keep", async () => {
    context.appState = { status: "recording", timerStartedAt: Date.now(), activeSourceType: "microphone" };
    context.recording.cancelRecording = vi.fn().mockResolvedValue(false);
    await render(<FloatingRecorderHud />);
    await act(async () => cancelKey());
    expect(window.ivritMenuBar.overlay.hide).toHaveBeenCalledOnce();
  });
  it("retries a failed transcription from the audio it kept", async () => {
    context.errorMessage = he.transcriptionProcessFailed; context.appState = { status: "error", timerStartedAt: null };
    context.recording.heldRecording = { reason: "failed", durationMs: 8_000 };
    context.recording.resendHeldRecording = vi.fn().mockResolvedValue(undefined);
    await render(<FloatingRecorderHud />);
    expect(host.textContent).toContain(he.recordingHeld);
    expect(button(he.startRecording)).toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === he.retryTranscription)!.click());
    expect(context.recording.resendHeldRecording).toHaveBeenCalledOnce();
  });
  it("does not show a Retry for held audio as a live recording while it goes back to the engine", async () => {
    context.appState = { status: "recording", timerStartedAt: Date.now(), activeSourceType: "microphone" };
    context.recording.isResending = true;
    await render(<FloatingRecorderHud />);
    expect(button(he.stopRecording)).toBeNull();
    expect(button(he.processingCancel)).toBeTruthy();
  });
  it("holds Undo after Esc while processing rather than closing", async () => {
    context.appState = { status: "processing", timerStartedAt: null, activeSourceType: "microphone" };
    context.recording.cancelProcessing = vi.fn().mockResolvedValue({ canceled: true, held: true });
    await render(<FloatingRecorderHud />);
    await act(async () => cancelKey());
    expect(context.recording.cancelProcessing).toHaveBeenCalledOnce();
    expect(window.ivritMenuBar.overlay.hide).not.toHaveBeenCalled();
  });
  it("starts on a held key and hands the release to the recording it began", async () => {
    await render(<FloatingRecorderHud />);
    await act(async () => holdKey("press"));
    expect(context.recording.beginHold).toHaveBeenCalledOnce();
    await act(async () => holdKey("release"));
    expect(context.recording.endHold).toHaveBeenCalledOnce();
  });
  it("does not start over speech that is still being transcribed", async () => {
    context.appState = { status: "processing", timerStartedAt: null, activeSourceType: "microphone" };
    await render(<FloatingRecorderHud />);
    await act(async () => holdKey("press"));
    expect(context.recording.beginHold).not.toHaveBeenCalled();
  });
  it("retries held audio from a held key instead of recording over it", async () => {
    context.recording.heldRecording = { reason: "failed", durationMs: 4_000 };
    await render(<FloatingRecorderHud />);
    await act(async () => holdKey("press"));
    expect(context.recording.resendHeldRecording).toHaveBeenCalledOnce();
    expect(context.recording.beginHold).not.toHaveBeenCalled();
  });
  it("keeps the window open when the shortcut stops a microphone that never opened", async () => {
    let toggle = () => {};
    Object.assign(window.ivritMenuBar.app, { onRecordingToggleRequested: (listener: () => void) => { toggle = listener; return () => {}; } });
    context.recording.isPreparing = true;
    vi.mocked(context.recording.abandonStart).mockResolvedValueOnce(true);
    await render(<FloatingRecorderHud />);
    await act(async () => toggle());
    expect(context.recording.abandonStart).toHaveBeenCalledOnce();
    expect(window.ivritMenuBar.overlay.hide).not.toHaveBeenCalled();
  });
  it("closes without comment when the shortcut was only a slip", async () => {
    let toggle = () => {};
    Object.assign(window.ivritMenuBar.app, { onRecordingToggleRequested: (listener: () => void) => { toggle = listener; return () => {}; } });
    context.recording.isPreparing = true;
    await render(<FloatingRecorderHud />);
    await act(async () => toggle());
    expect(window.ivritMenuBar.overlay.hide).toHaveBeenCalledOnce();
  });
  it("does not cancel processing from the dictation shortcut", async () => {
    let toggle = () => {};
    Object.assign(window.ivritMenuBar.app, { onRecordingToggleRequested: (listener: () => void) => { toggle = listener; return () => {}; } });
    context.appState = { status: "processing", timerStartedAt: null, activeSourceType: "microphone" };
    context.recording.cancelProcessing = vi.fn();
    await render(<FloatingRecorderHud />);
    await act(async () => toggle());
    expect(context.recording.cancelProcessing).not.toHaveBeenCalled();
    expect(window.ivritMenuBar.transcription.cancel).not.toHaveBeenCalled();
  });
  it("retries instead of discarding held audio when the shortcut is pressed after a failure", async () => {
    let toggle = () => {};
    Object.assign(window.ivritMenuBar.app, { onRecordingToggleRequested: (listener: () => void) => { toggle = listener; return () => {}; } });
    context.errorMessage = he.transcriptionProcessFailed; context.appState = { status: "error", timerStartedAt: null };
    context.recording.heldRecording = { reason: "failed", durationMs: 8_000 };
    context.recording.resendHeldRecording = vi.fn().mockResolvedValue(undefined);
    await render(<FloatingRecorderHud />);
    await act(async () => toggle());
    expect(context.recording.resendHeldRecording).toHaveBeenCalledOnce();
    expect(context.recording.startRecording).not.toHaveBeenCalled();
  });
  it.each(["confirmed", "unverified"] as const)("says nothing after a %s paste, because the text is already where the user looks", async insertionOutcome => {
    context.appState.overlaySession = { id: "pasted", phase: "success", insertionOutcome, transcriptId: "test", transcriptText: "טקסט", targetAppName: "Terminal", lastErrorCode: null };
    await render(<FloatingRecorderHud />);
    expect(host.textContent).toBe("");
    expect(button(he.copy)).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(window.ivritMenuBar.overlay.hide).toHaveBeenCalled();
  });
  it("names the app when focus moved, and only offers Copy for a secure field", async () => {
    context.appState.overlaySession = { id: "moved", phase: "paste_failed", transcriptId: "test", transcriptText: "טקסט", targetAppName: "Notes", lastErrorCode: "target_changed" };
    await render(<FloatingRecorderHud />);
    expect(button(he.pasteIntoApp("Notes"))).toBeTruthy(); expect(button(he.copy)).toBeTruthy();
    context.appState.overlaySession = { ...context.appState.overlaySession, lastErrorCode: "secure_field", manualCopyOnly: true, insertionOutcome: "not_dispatched" };
    await render(<FloatingRecorderHud />);
    expect(button(he.pasteIntoApp("Notes"))).toBeNull(); expect(button(he.retry)).toBeNull();
    expect(button(he.copy)).toBeTruthy(); expect(host.textContent).toContain(he.textInsertionSecureField);
  });
  it("does not claim a paste when the text stayed in Meluli", async () => {
    context.appState.overlaySession = { id: "here", phase: "success", deliveredInApp: true, transcriptId: "test", transcriptText: "טקסט", targetAppName: null, lastErrorCode: null };
    await render(<FloatingRecorderHud />);
    expect(host.textContent).toContain(he.transcriptReadyInApp);
    expect(button(he.copy)).toBeTruthy();
  });
  it("does not show a live timer while the microphone is still opening", async () => {
    context.appState = { status: "recording", timerStartedAt: Date.now(), activeSourceType: "microphone" };
    context.recording.isPreparing = true;
    await render(<FloatingRecorderHud />);
    expect(host.querySelector(".hud-time")).toBeNull();
    expect(button(he.stopRecording)).toBeNull();
  });
  it("does not claim to be recording while the microphone is still opening", async () => {
    context.appState = { status: "recording", timerStartedAt: Date.now(), activeSourceType: "microphone" };
    context.recording.isPreparing = true;
    await render(<FloatingRecorderHud />);
    expect(host.textContent).not.toContain(he.workspaceRecordingHint);
  });
  it("stays compact while nothing needs explaining and grows for an error", async () => {
    await render(<FloatingRecorderHud />);
    expect(window.ivritMenuBar.overlay.setSize).toHaveBeenLastCalledWith("compact");
    context.errorMessage = he.recordingFailed; context.appState = { status: "error", timerStartedAt: null };
    await render(<FloatingRecorderHud />);
    expect(window.ivritMenuBar.overlay.setSize).toHaveBeenLastCalledWith("expanded");
  });
});

it("reduced motion and a hidden document never open an audio analyser", async () => {
  const create = vi.fn(); vi.stubGlobal("AudioContext", create); reduced = true;
  await render(<BarVisualizer state="speaking" mediaStream={{} as MediaStream} />); expect(create).not.toHaveBeenCalled();
  reduced = false; vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await render(<BarVisualizer key="hidden" state="speaking" mediaStream={{} as MediaStream} />); expect(create).not.toHaveBeenCalled();
});


it("stops reading the microphone as soon as reduced motion turns on", async () => {
  const preference = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => preference);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext", class {
    close = close; resume = vi.fn().mockResolvedValue(undefined);
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createAnalyser = () => ({ frequencyBinCount: 128, getFloatFrequencyData: vi.fn() });
  });
  await render(<BarVisualizer state="speaking" mediaStream={{} as MediaStream} />);
  expect(close).not.toHaveBeenCalled();
  await act(async () => { preference.matches = true; preference.dispatchEvent(new Event("change")); });
  expect(close).toHaveBeenCalledOnce();
});

it("clearing search returns focus to the field", async () => {
  context.transcripts.searchQuery = "מילה";
  await render(<App />);
  const field = host.querySelector<HTMLInputElement>("#history-search")!;
  await act(async () => button(he.clearSearch).click());
  expect(context.transcripts.setSearchQuery).toHaveBeenCalledWith("");
  expect(document.activeElement).toBe(field);
});

it("dismissing a notice leaves focus in the content", async () => {
  context.errorMessage = "הפעולה לא הושלמה.";
  await render(<App />);
  const close = button("סגירת הודעה"); close.focus();
  await act(async () => close.click());
  expect(context.setErrorMessage).toHaveBeenCalledWith(null);
  expect(document.activeElement).toBe(host.querySelector("#main-content"));
});

it("cancelling a queued link returns focus to the YouTube cell", async () => {
  context.appState = { status: "processing", timerStartedAt: null, activeSourceType: "imported_file", pendingYoutubeJob: { url: "https://youtu.be/abcdefghijk" } };
  await render(<YouTubeInputRow />);
  await act(async () => button(he.youtubeCancelPending).click());
  context.appState = { status: "processing", timerStartedAt: null, activeSourceType: "imported_file" };
  await render(<YouTubeInputRow />);
  expect(document.activeElement).toBe(host.querySelector("input"));
});

it("announces copy results and search outcomes through regions that are already mounted", async () => {
  await render(<CopyButton text="טקסט" />);
  const copied = host.querySelector('[role="status"]')!;
  expect(copied.textContent).toBe("");
  await act(async () => button(he.copy).click());
  expect(copied.textContent).toBe(he.copied);
  context.transcripts.items = [transcript];
  await render(<HistoryPanel />);
  const status = host.querySelector(".history-browser [role=\"status\"]")!;
  expect(status.textContent).toBe("");
  context.transcripts.items = []; context.transcripts.searchQuery = "לא קיים";
  await render(<HistoryPanel />);
  expect(host.querySelector(".history-browser [role=\"status\"]")).toBe(status);
  expect(status.textContent).toContain("לא נמצאו תמלולים");
});

it("shows the floating window's position on a picture of the screen", async () => {
  const onChange = vi.fn();
  await render(<OverlayPositionPicker value="top-right" labelledBy="title" describedBy="hint" onChange={onChange} />);
  expect(document.querySelector<HTMLInputElement>(`input[aria-label="${he.overlayPositions["top-right"]}"]`)?.checked).toBe(true);
  expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(9);
  await act(async () => document.querySelector<HTMLInputElement>(`input[aria-label="${he.overlayPositions["bottom-left"]}"]`)!.click());
  expect(onChange).toHaveBeenCalledWith("bottom-left");
  await act(async () => document.querySelector<HTMLInputElement>('input[value="last"]')!.click());
  expect(onChange).toHaveBeenCalledWith("last");
});

it("names the supported sites on request and links to the full list", async () => {
  await render(<SupportedSitesInfo />);
  expect(document.body.textContent).not.toContain("SoundCloud");
  await act(async () => button(he.supportedSitesLabel).click());
  expect(document.body.textContent).toContain("SoundCloud");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === he.supportedSitesAll)!.click());
  expect(window.ivritMenuBar.files.openExternal).toHaveBeenCalledWith(SUPPORTED_SITES_URL);
});

it("takes a dropped file, and shows the cell is ready for it", async () => {
  const file = new File(["x"], "a.m4a");
  const onDropFile = vi.fn();
  const drag = (type: string) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" } }); return event; };
  await render(<FileDropCell disabled={false} onPick={vi.fn()} onDropFile={onDropFile} />);
  const cell = host.querySelector("button")!;
  await act(async () => { cell.dispatchEvent(drag("dragover")); });
  expect(cell.hasAttribute("data-dropping")).toBe(true);
  expect(cell.textContent).toContain(he.importAudioDrop);
  await act(async () => { cell.dispatchEvent(drag("drop")); });
  expect(onDropFile).toHaveBeenCalledWith(file);
  expect(cell.hasAttribute("data-dropping")).toBe(false);
});

it("refuses a drop while the app is busy", async () => {
  const onDropFile = vi.fn();
  await render(<FileDropCell disabled onPick={vi.fn()} onDropFile={onDropFile} />);
  const cell = host.querySelector("button")!;
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: { types: ["Files"], files: [new File(["x"], "a.m4a")], dropEffect: "none" } });
  await act(async () => { cell.dispatchEvent(event); });
  expect(onDropFile).not.toHaveBeenCalled();
});

it("invalid YouTube input explains the problem and does not invoke transcription", async () => {
  await render(<YouTubeInputRow />);
  const input = host.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "http://localhost/not-public"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(context.submitYouTubeUrl).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(document.activeElement).toBe(input);
});

describe("recovery on Home", () => {
  const phaseSettings = (phase: "needs_first_transcript" | "activated", modelState: "ready" | "missing" = "ready") => {
    const settings = appSettingsSchema.parse({ onboarding: { phase, surface: "workspace", activatedAt: phase === "activated" ? 1 : null, completedOptionalActions: [], dismissedOptionalActions: [] } });
    settings.modelState.downloadState = modelState;
    context.settings = settings;
    context.onboarding = deriveOnboardingDisplayState(settings, context.permissionStatus);
  };

  it("teaches the shortcut and paste permission once setup finishes", async () => {
    context.accessibilityPermissionStatus = "denied";
    phaseSettings("needs_first_transcript");
    await render(<WorkspaceView />);
    expect(host.textContent).toContain(he.onboardingFirstTranscriptTitle);
    expect(host.querySelector("kbd")?.textContent).toBeTruthy();
    expect(host.textContent).toContain(he.onboardingAccessibilityHint);
    await act(async () => button(he.close).click());
    expect(context.dismissOnboardingOptionalAction).toHaveBeenCalledWith("recording_shortcut");
  });

  it("stays out of the way once dismissed", async () => {
    phaseSettings("needs_first_transcript");
    context.settings!.onboarding.dismissedOptionalActions = ["recording_shortcut"];
    await render(<WorkspaceView />);
    expect(host.textContent).not.toContain(he.onboardingFirstTranscriptTitle);
  });

  it("offers the download when the model goes missing after activation", async () => {
    phaseSettings("activated", "missing");
    vi.mocked(context.downloadModel).mockResolvedValue(undefined);
    await render(<WorkspaceView />);
    expect(host.textContent).toContain(he.modelMissingBody);
    await act(async () => button(he.downloadHebrewModel).click());
    expect(context.downloadModel).toHaveBeenCalled();
  });

  it.each(["denied", "restricted"] as const)("points to System Settings when the microphone is %s", async permissionStatus => {
    const openMicrophoneSettings = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.ivritMenuBar, { permissions: { openMicrophoneSettings } });
    context.permissionStatus = permissionStatus;
    phaseSettings("activated");
    await render(<WorkspaceView />);
    await act(async () => button(he.openSystemSettings).click());
    expect(openMicrophoneSettings).toHaveBeenCalled();
  });

  it("warns before a recording reaches the twenty minute limit", async () => {
    context.appState = { status: "recording", timerStartedAt: Date.now() - 19.5 * 60_000 };
    await render(<RecordingArea />);
    expect(host.textContent).toContain(he.recordingLimitSoon);
  });

  it("does not warn early", async () => {
    context.appState = { status: "recording", timerStartedAt: Date.now() - 60_000 };
    await render(<RecordingArea />);
    expect(host.textContent).not.toContain(he.recordingLimitSoon);
  });
});

it("Escape clears a search query before it leaves the view", async () => {
  const onChange = vi.fn(), onParentKey = vi.fn();
  await render(<div onKeyDown={onParentKey}><SearchInput value="שלום" onChange={onChange} placeholder="חיפוש" /></div>);
  await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onChange).toHaveBeenCalledWith("");
  expect(onParentKey).not.toHaveBeenCalled();
});

it("shows the app version on the About page", async () => {
  Object.assign(window.ivritMenuBar, { app: { version: vi.fn().mockResolvedValue("1.2.3") } });
  await render(<InfoPage title="אודות" sections={[{ paragraphs: ["טקסט"] }]} onBack={vi.fn()} showVersion />);
  expect(host.textContent).toContain(`${he.appVersion} 1.2.3`);
});

it("gives each legal section a heading and shows when the page was updated", async () => {
  await render(<InfoPage title="תנאים" sections={[{ title: "רישיון", paragraphs: ["טקסט"] }]} footnote={he.legalLastUpdated} onBack={vi.fn()} />);
  expect(host.querySelector("h3")?.textContent).toBe("רישיון");
  expect(host.textContent).toContain(he.legalLastUpdated);
});

it("reports a failed launch with a way to retry", async () => {
  context.loadFailed = true;
  await render(<App />);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(he.startupFailed);
});

it("rejects a shortcut with no modifier and says why", async () => {
  await render(<ShortcutEditor id="recording-shortcut" label="הקלטה" description="תיאור" value="Control+Shift+R" onSave={vi.fn()} />);
  const input = host.querySelector("input")!;
  await act(async () => input.focus());
  expect(host.textContent).toContain(he.shortcutEditHint);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", bubbles: true })));
  expect(host.textContent).toContain(he.shortcutNeedsModifier);
  expect(input.value).not.toBe("R");
});
