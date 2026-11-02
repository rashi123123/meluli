/* @vitest-environment node */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntime } from "@main/runtime";
import { IPC_CHANNELS } from "@shared/ipc-channels";

const h = vi.hoisted(() => {
  const emitter = () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    return {
      on: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener); },
      emit: (name: string, ...args: unknown[]) => listeners.get(name)?.(...args)
    };
  };
  return { emitter, app: null as never as Record<string, never>, powerMonitor: emitter(), services: null as unknown, mainWindow: null as unknown };
});

vi.mock("electron", () => ({
  get app() { return h.app; },
  powerMonitor: h.powerMonitor,
  session: { defaultSession: {} },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] }
}));
vi.mock("@main/services/container", () => ({ createAppServiceContainer: vi.fn(() => h.services) }));
vi.mock("@main/ipc/register", () => ({ registerIpcHandlers: vi.fn(), microphoneStatus: () => "granted" }));
vi.mock("@main/window", () => ({ createMainWindow: () => h.mainWindow }));
vi.mock("@main/overlay-snap", () => ({ attachOverlaySnap: vi.fn() }));
vi.mock("@main/theme", () => ({ applyTheme: vi.fn(), getWindowBackground: () => "#000" }));
vi.mock("@main/app-icon", () => ({ createAppIcon: vi.fn() }));
vi.mock("@main/security", () => ({ createRendererSecurityEnvironment: vi.fn(), installSessionPermissionHandlers: vi.fn() }));
vi.mock("@main/perf-audit", () => ({ markPerformanceAudit: vi.fn(), schedulePerformanceAuditStop: vi.fn(), startPerformanceAudit: vi.fn(async () => {}), stopPerformanceAudit: vi.fn(async () => {}) }));
vi.mock("@main/hold-to-talk", () => ({ HoldToTalk: vi.fn() }));
vi.mock("@main/overlay-controller", () => ({ OverlayController: vi.fn() }));
vi.mock("@main/tray", () => ({ TrayManager: vi.fn(function () { return { init: vi.fn() }; }) }));
vi.mock("@main/shortcuts", () => ({ ShortcutManager: vi.fn(function () { return { registerAll: vi.fn(), setEscapeActive: vi.fn(), setUndoActive: vi.fn(), dispose: vi.fn() }; }) }));

const argv = process.argv;
let profile: string;
let runtime: AppRuntime;
let mainWindow: { show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; isMinimized: ReturnType<typeof vi.fn>; webContents: { id: number; send: ReturnType<typeof vi.fn> } };
let calls: { suspend: ReturnType<typeof vi.fn>; initialize: ReturnType<typeof vi.fn> };
const app = () => h.app as unknown as Record<string, ReturnType<typeof vi.fn>> & { emit: (name: string, ...args: unknown[]) => void };
const launch = () => import("@main/index");
const booted = () => vi.waitFor(() => expect(calls.initialize).toHaveBeenCalled());

beforeEach(() => {
  vi.resetModules();
  profile = mkdtempSync(join(tmpdir(), "meluli-startup-"));
  const events = h.emitter();
  h.app = {
    ...events, isPackaged: false, exit: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), setName: vi.fn(), setActivationPolicy: vi.fn(),
    getPath: vi.fn(() => profile), setPath: vi.fn(), requestSingleInstanceLock: vi.fn(() => true), whenReady: vi.fn(async () => {})
  } as never;
  runtime = new AppRuntime();
  calls = { suspend: vi.fn(async () => {}), initialize: vi.fn(async () => {}) };
  mainWindow = {
    show: vi.fn(), focus: vi.fn(), restore: vi.fn(), isMinimized: vi.fn(() => false),
    webContents: { id: 7, send: vi.fn() }
  };
  Object.assign(mainWindow, { on: vi.fn(), once: vi.fn(), isDestroyed: () => false });
  Object.assign(mainWindow.webContents, { on: vi.fn(), once: vi.fn(), isDestroyed: () => false, isLoadingMainFrame: () => false });
  h.mainWindow = mainWindow;
  h.services = {
    runtime, calls, holdKey: { sync: vi.fn(async () => {}), recheck: vi.fn() }, updates: { sync: vi.fn() },
    settingsService: { getSettings: () => ({ theme: "system", shortcut: "Control+Shift+R", overlayShortcut: "Control+Shift+H" }) },
    getTextInsertionService: () => ({ isAttentionOnTarget: () => false, getFrontmostPid: () => 1 })
  };
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(profile, { recursive: true, force: true });
});

describe("launch switches", () => {
  it("exits a packaged app on a debug switch before anything starts", async () => {
    app().isPackaged = true as never;
    process.argv = [...argv, "--remote-debugging-port=9222"];
    await launch();
    expect(app().exit).toHaveBeenCalledWith(1);
    expect(app().requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(app().whenReady).not.toHaveBeenCalled();
  });
  it("starts a packaged app with the fake device flags", async () => {
    app().isPackaged = true as never;
    process.argv = [...argv, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
    await launch();
    await booted();
    expect(app().exit).not.toHaveBeenCalled();
  });
  it("leaves a development launch alone, which Playwright drives through a debug port", async () => {
    process.argv = [...argv, "--remote-debugging-port=0", "--inspect=0"];
    await launch();
    await booted();
    expect(app().exit).not.toHaveBeenCalled();
  });
  it("lets a test-only build take debug switches", async () => {
    vi.stubGlobal("__MELULI_ALLOW_DEBUG_SWITCHES__", true);
    app().isPackaged = true as never;
    process.argv = [...argv, "--remote-debugging-port=9222"];
    await launch();
    await booted();
    expect(app().exit).not.toHaveBeenCalled();
  });
});

describe("development environment", () => {
  const flags = ["IVRIT_E2E_MOCK", "IVRIT_USE_MOCK_SERVICES", "ELECTRON_RENDERER_URL", "MELULI_DICTATION_MODE", "MELULI_EXPERIMENT_ASSETS", "MELULI_EXPERIMENTAL_DICTATION", "MELULI_FINALIZE_OVERLAP", "MELULI_NATIVE_PASTE", "MELULI_OFFLINE_RESEARCH", "MELULI_PIPELINE_TRACE", "MELULI_RESERVE_DURING_FINALIZE"];
  const stubAll = () => [...flags, "MELULI_DICTATION_TIMING"].forEach((name) => vi.stubEnv(name, "1"));

  it("is cleared from a packaged app before it starts", async () => {
    app().isPackaged = true as never;
    stubAll();
    await launch();
    await booted();
    for (const name of [...flags, "MELULI_DICTATION_TIMING"]) expect(process.env[name], name).toBeUndefined();
  });
  it("keeps the isolated profile that packaged tests depend on", async () => {
    app().isPackaged = true as never;
    vi.stubEnv("MELULI_USER_DATA", join(profile, "isolated"));
    await launch();
    await booted();
    expect(process.env.MELULI_USER_DATA).toBe(join(profile, "isolated"));
  });
  it("keeps stage timing in a test-only build, and still clears the rest", async () => {
    vi.stubGlobal("__MELULI_ALLOW_DEBUG_SWITCHES__", true);
    app().isPackaged = true as never;
    stubAll();
    await launch();
    await booted();
    expect(process.env.MELULI_DICTATION_TIMING).toBe("1");
    for (const name of flags) expect(process.env[name], name).toBeUndefined();
  });
  it("is left alone in development", async () => {
    vi.stubEnv("MELULI_PIPELINE_TRACE", "1");
    await launch();
    await booted();
    expect(process.env.MELULI_PIPELINE_TRACE).toBe("1");
  });
});

describe("single instance", () => {
  it("takes the lock on the profile it was given, before the app is ready", async () => {
    const isolated = join(profile, "isolated");
    vi.stubEnv("MELULI_USER_DATA", isolated);
    await launch();
    await booted();
    vi.unstubAllEnvs();
    expect(app().setPath).toHaveBeenCalledWith("userData", isolated);
    expect(app().setPath.mock.invocationCallOrder[0]).toBeLessThan(app().requestSingleInstanceLock.mock.invocationCallOrder[0]!);
    expect(app().requestSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(app().whenReady.mock.invocationCallOrder[0]!);
  });
  it("quits when another process holds the profile", async () => {
    app().requestSingleInstanceLock.mockReturnValue(false);
    await launch();
    await vi.waitFor(() => expect(app().quit).toHaveBeenCalled());
    expect(app().whenReady).not.toHaveBeenCalled();
    expect(calls.initialize).not.toHaveBeenCalled();
  });
  it("brings the main window forward on a second launch", async () => {
    await launch();
    await booted();
    mainWindow.show.mockClear(); mainWindow.focus.mockClear();
    mainWindow.isMinimized.mockReturnValue(true);
    app().emit("second-instance");
    expect(mainWindow.restore).toHaveBeenCalledOnce();
    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(mainWindow.focus).toHaveBeenCalledOnce();
  });
});

describe("sleep", () => {
  it("interrupts a recording owned by the main window, which has no overlay session", async () => {
    await launch();
    await booted();
    runtime.claimRecording(mainWindow.webContents.id);
    runtime.updateState({ status: "recording", activeSourceType: "microphone", timerStartedAt: 1 });
    h.powerMonitor.emit("suspend");
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.recordingInterruptRequested, null);
    expect(calls.suspend).toHaveBeenCalledOnce();
  });
  it("interrupts nothing when nothing is recording, and still suspends calls", async () => {
    await launch();
    await booted();
    h.powerMonitor.emit("suspend");
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.recordingInterruptRequested, null);
    expect(calls.suspend).toHaveBeenCalledOnce();
  });
});
