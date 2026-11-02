// Real registerIpcHandlers, AppRuntime, OverlayController, TranscriptionWorkflowService, useRecording
// and FloatingRecorderHud. Faked: electron, microphone, engine, paste.
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const h = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: never) => h.handlers.set(channel, fn) },
  app: { isPackaged: true, getVersion: () => "0", getPath: () => "/nonexistent" },
  dialog: {}, shell: {}, systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, Notification: { isSupported: () => false },
  nativeImage: {}, screen: {}, clipboard: {}, globalShortcut: {}, session: {}, powerMonitor: {}, autoUpdater: {}, Menu: {}, Tray: {}, nativeTheme: {}
}));
const mic = vi.hoisted(() => ({ live: false }));
vi.mock("@/lib/audio-capture", () => ({
  AudioCaptureController: vi.fn(function () {
    return {
      durationLimitReached: false,
      setStrictFlush() {}, setChunkListener() {}, getMediaStream: () => null, getElapsedDurationMs: () => 0,
      start: async () => { mic.live = true; },
      stop: async () => { mic.live = false; return { pcm: new Float32Array(16_000).fill(0.1), sampleRate: 16_000, durationMs: 4_000 }; },
      destroy: async () => { mic.live = false; }
    };
  })
}));
vi.mock("@/lib/sounds", () => ({ playCue: vi.fn(async () => undefined) }));
vi.mock("@/components/ui/bar-visualizer", () => ({ BarVisualizer: () => null, useDocumentVisible: () => true }));

import { AppContext, type AppContextValue } from "@/context/app-context";
import { FloatingRecorderHud } from "@/features/overlay/FloatingRecorderHud";
import { useRecording } from "@/hooks/use-recording";
import { AppRuntime } from "@main/runtime";
import { OverlayController } from "@main/overlay-controller";
import { registerIpcHandlers } from "@main/ipc/register";
import { TranscriptionWorkflowService } from "@main/services/transcription-workflow.service";
import { IPC_CHANNELS as C } from "@shared/ipc-channels";
import { appSettingsSchema } from "@shared/schemas";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { he } from "@shared/locale";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

function fakeWindow(id: number, role: string, sink: (channel: string, payload: unknown) => void) {
  const mainFrame = { url: `file:///Applications/Meluli.app/Contents/Resources/app.asar/out/renderer/index.html?window=${role}` };
  const webContents = { id, mainFrame, isDestroyed: () => false, isLoadingMainFrame: () => false, on() {}, once() {}, send: sink };
  return { webContents, isDestroyed: () => false, isVisible: () => true, on() {}, hide() {}, showInactive() {} };
}

let root: Root, host: HTMLDivElement, runtime: AppRuntime, controller: OverlayController, directory: string;
let capturing: Promise<void> | null, captureGate: ReturnType<typeof deferred> | null, errors: string[];
let convert: ReturnType<typeof vi.fn>, listeners: Record<string, (payload: unknown) => void>;
let overlayWin: ReturnType<typeof fakeWindow>, mainWin: ReturnType<typeof fakeWindow>;
const invoke = (win: ReturnType<typeof fakeWindow>, channel: string, input?: unknown) => h.handlers.get(channel)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, input);

const settings = appSettingsSchema.parse({ onboarding: { phase: "activated", surface: "workspace", activatedAt: 1, completedOptionalActions: ["recording_shortcut", "overlay_accessibility"], dismissedOptionalActions: [] } });
settings.modelState.downloadState = "ready";

function Hud() {
  const [state, setState] = useState(runtime.getState());
  useEffect(() => { const update = (next: typeof state) => setState({ ...next }); runtime.on("state", update); return () => { runtime.off("state", update); }; }, []);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const recording = useRecording({ windowMode: "overlay", timerStartedAt: state.timerStartedAt, microphoneDeviceId: null, permissionStatus: "granted",
    requestPermission: async () => undefined, onTranscript: () => undefined, onError: (message: string) => { errors.push(message); setErrorMessage(message); } });
  const value = { loading: false, settings, appState: state, permissionStatus: "granted", accessibilityPermissionStatus: "granted", onboarding: deriveOnboardingDisplayState(settings, "granted"),
    errorMessage, setErrorMessage, recording, requestAccessibilityPermission: vi.fn() } as unknown as AppContextValue;
  return <AppContext.Provider value={value}><FloatingRecorderHud /></AppContext.Provider>;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "meluli-claim-"));
  h.handlers.clear(); mic.live = false; capturing = null; captureGate = null; errors = []; listeners = {};
  runtime = new AppRuntime();
  overlayWin = fakeWindow(2, "overlay", (channel, payload) => listeners[channel]?.(payload));
  mainWin = fakeWindow(1, "main", () => undefined);
  runtime.setWindow("overlay", overlayWin as never); runtime.setWindow("main", mainWin as never);
  const insertion = {
    whenCaptureSettled: () => capturing ?? Promise.resolve(),
    captureCurrentTargetApplication: () => {
      const settled = (captureGate ? captureGate.promise : Promise.resolve()).then(() => { capturing = null; });
      capturing = settled; return settled;
    },
    getCapturedTargetApplicationName: () => "Notes", clearTargetApplication: () => undefined
  };
  const transcriptionService = { transcribe: vi.fn(), cancel: () => false, on() {}, prewarm: async () => undefined, isBusy: false };
  const database = { transcriptRepository: { create: vi.fn() }, paths: { transcriptsDir: join(directory, "transcripts"), userDataPath: directory } };
  const settingsService = { getSettings: () => settings, setSetting: vi.fn() };
  convert = vi.fn(async () => undefined);
  const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
    audioConverter: { convertInputToWav: convert } as never, transcriptionService: transcriptionService as never,
    textInsertionService: insertion as never, showMainWindow: () => undefined });
  controller = new OverlayController({ runtime, textInsertion: () => insertion as never, show: () => undefined, hide: () => undefined });
  registerIpcHandlers({ database, runtime, settingsService, getModelManager: () => ({}), getTranscriptionService: () => transcriptionService, getTranscriptionWorkflow: () => workflow,
    getYouTubeQueueService: () => ({}), shortcutManager: {}, getTextInsertionService: () => insertion, holdKey: {}, calls: {}, updates: {}, installUpdate: () => undefined,
    hideOverlay: () => controller.hide(), setOverlaySize: () => undefined, openOverlay: () => undefined, retargetOverlay: () => controller.retarget(), showMain: () => undefined, applyTheme: () => undefined, isPackaged: true } as never);
  const on = (channel: string) => (listener: (payload: unknown) => void) => { listeners[channel] = listener; return () => {}; };
  const asOverlay = (channel: string) => (input?: unknown) => invoke(overlayWin, channel, input);
  Object.assign(window, { ivritMenuBar: {
    app: { isMockMode: async () => false, onRecordingToggleRequested: on(C.recordingToggleRequested), onRecordingHoldRequested: on(C.recordingHoldRequested),
      onRecordingCancelRequested: on(C.recordingCancelRequested), onRecordingUndoRequested: on(C.recordingUndoRequested), onRecordingInterruptRequested: on(C.recordingInterruptRequested) },
    recording: { start: (startedAt: number) => asOverlay(C.recordingStart)({ startedAt }), stop: asOverlay(C.recordingStop), pause: (elapsedMs: number) => asOverlay(C.recordingPause)({ elapsedMs }),
      sendAudio: asOverlay(C.recordingSendAudio), experimentalEnabled: asOverlay(C.dictationEnabled), experimentalBegin: asOverlay(C.dictationBegin) },
    transcription: { cancel: asOverlay(C.transcriptionCancel), onFailed: () => () => {} },
    overlay: { ready: async () => runtime.setOverlayReady(), hide: asOverlay(C.overlayHide), retarget: asOverlay(C.overlayRetarget), setHeldRecording: (reason: never) => runtime.setHeldRecording(reason), setSize: async () => undefined, onSnapPreview: () => () => {} },
    textInsert: { intoFocusedField: vi.fn() }
  } });
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} });
  window.localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Hud />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

const settle = () => act(async () => { for (let i = 0; i < 40; i += 1) await new Promise(r => setTimeout(r, 5)); });
const stopOffered = () => [...host.querySelectorAll("button")].some(button => (button.getAttribute("aria-label") || button.textContent) === he.stopRecording);
const pressWhileTargetIsCaptured = async () => {
  captureGate = deferred();
  await act(async () => { void controller.toggleRecording(); });
  await settle();
};

describe("the recording claim", () => {
  it("refuses an import after the recording has started", async () => {
    const file = join(directory, "dropped.wav"); writeFileSync(file, "x");
    await act(async () => { await controller.toggleRecording(); });
    await settle();
    await expect(invoke(mainWin, C.fileImportDroppedAudio, file)).rejects.toThrow("כבר יש הקלטה");
    expect(runtime.getState().status).toBe("recording");
  });
  it("refuses an import in the gap before the status says recording, and keeps the stop control", async () => {
    const file = join(directory, "dropped.wav"); writeFileSync(file, "x");
    await pressWhileTargetIsCaptured();
    expect(runtime.hasRecordingOwner()).toBe(true);
    expect(runtime.getState().status).toBe("idle");
    await expect(invoke(mainWin, C.fileImportDroppedAudio, file)).rejects.toThrow("כבר יש הקלטה");
    expect(convert).not.toHaveBeenCalled();
    await act(async () => { captureGate!.resolve(); });
    await settle();
    expect(runtime.getState()).toMatchObject({ status: "recording", activeSourceType: "microphone" });
    expect(mic.live).toBe(true);
    expect(stopOffered()).toBe(true);
  });
  it("fails the start rather than writing over a job that took the status meanwhile", async () => {
    await pressWhileTargetIsCaptured();
    runtime.updateState({ status: "youtube_downloading", activeSourceType: "youtube" });
    await act(async () => { captureGate!.resolve(); });
    await settle();
    expect(runtime.getState()).toMatchObject({ status: "youtube_downloading", activeSourceType: "youtube", overlaySession: null });
    expect(runtime.hasRecordingOwner()).toBe(false);
    expect(mic.live).toBe(false);
    expect(errors).toEqual(["כבר יש הקלטה או עיבוד פעילים."]);
  });
});
