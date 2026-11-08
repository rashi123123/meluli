import { app, BrowserWindow, dialog, powerMonitor, session } from "electron";
import { he } from "@shared/locale";
import { mkdirSync } from "node:fs";
import { resolveUserDataPath } from "./config/user-data";
import { APP_ID, APP_NAME, DEFAULT_OVERLAY_SHORTCUT, DEFAULT_SHORTCUT } from "@shared/constants";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { registerIpcHandlers } from "./ipc/register";
import { microphoneStatus } from "./system-permissions";
import { createMainWindow, createOverlayWindow, positionOverlayWindow, resizeOverlayWindow, createCallWindow, placeCallWindow, type CallWindowMode } from "./window";
import { attachOverlaySnap } from "./overlay-snap";
import { applyTheme, getWindowBackground } from "./theme";
import { HoldToTalk } from "./hold-to-talk";
import { OverlayController } from "./overlay-controller";
import { TrayManager } from "./tray";
import { MainWindowHost } from "./main-window-host";
import type { MainView } from "@shared/types";
import { ShortcutManager } from "./shortcuts";
import { createAppServiceContainer } from "./services/container";
import { createAppIcon } from "./app-icon";
import { clearDevelopmentEnv, debugSwitchesAllowed, findRefusedSwitch } from "./launch-switches";
import {
  appRendererSecurity,
  installSessionPermissionHandlers
} from "./security";
import {
  markPerformanceAudit,
  schedulePerformanceAuditStop,
  startPerformanceAudit,
  stopPerformanceAudit
} from "./diagnostics/perf-audit";
import { isDictating, isFree, isRecording, isWorking, mayRetarget, RUNTIME_STATE_EVENT } from "./runtime";

const refusedSwitch = app.isPackaged && !debugSwitchesAllowed()
  ? findRefusedSwitch([...process.argv, ...process.execArgv])
  : null;
if (refusedSwitch) {
  console.error(`[startup] refusing to run with --${refusedSwitch}`);
  app.exit(1);
}

// A shipped app must never accept the test doubles, which report a paste that did not happen.
if (app.isPackaged) clearDevelopmentEnv(process.env);

let mainHost: MainWindowHost | null = null;
// A main window hidden this long gives its renderer back. Reopening after that costs a page load.
const DEFAULT_MAIN_RELEASE_MS = 30_000;
const requestedMainRelease = Number(process.env.MELULI_MAIN_RELEASE_MS ?? DEFAULT_MAIN_RELEASE_MS);
const MAIN_RELEASE_MS = Number.isFinite(requestedMainRelease) ? requestedMainRelease : DEFAULT_MAIN_RELEASE_MS;
// Quitting waits this long for services to stop, and exits regardless after the deadline.
const QUIT_CLEANUP_MS = 10_000;
const QUIT_DEADLINE_MS = 20_000;
let overlayWindow: BrowserWindow | null = null;
let disposeOverlaySnap: (() => void) | null = null;
let overlayController: OverlayController | null = null;
let isQuitting = false;
let currentServices: ReturnType<typeof createAppServiceContainer> | null = null;

function ensureDockVisibility(): void {
  if (process.platform !== "darwin") {
    return;
  }

  app.setActivationPolicy("regular");
  void app.dock?.show();
}

function ensureOverlayWindow(services: ReturnType<typeof createAppServiceContainer>): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  overlayWindow = createOverlayWindow();
  registerOverlayWindowLifecycle(overlayWindow, services);
  services.runtime.setWindow("overlay", overlayWindow);

  disposeOverlaySnap?.();
  disposeOverlaySnap = attachOverlaySnap(overlayWindow);
  overlayWindow.on("closed", () => {
    disposeOverlaySnap?.();
    disposeOverlaySnap = null;
  });

  return overlayWindow;
}

function installProcessPipeGuards(): void {
  const ignoreBrokenPipe = (error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPIPE"
    ) {
      return;
    }

    setImmediate(() => {
      throw error instanceof Error ? error : new Error(String(error));
    });
  };

  process.stdout?.on("error", ignoreBrokenPipe);
  process.stderr?.on("error", ignoreBrokenPipe);
}

function showMainWindow(view: MainView | null = null): void {
  mainHost?.show(view);
}

function toggleMainWindow(): void {
  mainHost?.toggle();
}

function showOverlayWindow(activate = true): void {
  if (!currentServices) {
    return;
  }

  const window = ensureOverlayWindow(currentServices);

  positionOverlayWindow(window, currentServices.settingsService.getSettings().overlayPosition);
  if (activate) {
    window.show();
    window.focus();
    return;
  }

  window.showInactive();
}

function hideOverlayWindow(): boolean {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }

  return overlayController?.hide() ?? false;
}

function registerOverlayWindowLifecycle(window: BrowserWindow, services: ReturnType<typeof createAppServiceContainer>): void {
  window.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    hideOverlayWindow();
  });

  window.on("blur", () => {
    const state = services.runtime.getState();
    // Selecting a text field while the idle HUD is open updates its paste target.
    // Recording/processing/recovery sessions keep the target captured at start.
    if (mayRetarget(state)) {
      void services.getTextInsertionService().captureCurrentTargetApplication(() => mayRetarget(services.runtime.getState()));
    }
  });

  // A floating recorder stays visible across focus changes. Only explicit dismissal
  // (or successful paste timeout) hides it; activation events can otherwise race
  // with the first show and hide the HUD before the user has started recording.

}

async function bootstrap(): Promise<void> {
  markPerformanceAudit("bootstrap:start");
  installProcessPipeGuards();
  app.setAppUserModelId(APP_ID);
  app.setName(APP_NAME);
  const userDataPath = resolveUserDataPath(app.getPath("appData"), process.env);
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  app.setPath("userData", userDataPath);
  // The lock belongs to the profile, so an isolated MELULI_USER_DATA run takes its own.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());
  await app.whenReady();
  await startPerformanceAudit(app.getPath("userData"));
  markPerformanceAudit("app:ready");
  if (process.platform === "darwin") {
    ensureDockVisibility();
    // A packaged app keeps the system-rendered icon; setIcon would flatten its Liquid Glass.
    if (!app.isPackaged) app.dock?.setIcon(createAppIcon());
  }

  markPerformanceAudit("services:create:start");
  const services = createAppServiceContainer({
    app,
    showMainWindow
  });
  markPerformanceAudit("services:create:end");
  currentServices = services;
  const rendererSecurity = appRendererSecurity();

  markPerformanceAudit("security:session-handlers:start");
  installSessionPermissionHandlers(session.defaultSession, services.runtime, rendererSecurity);
  app.on("session-created", (createdSession) => {
    installSessionPermissionHandlers(createdSession, services.runtime, rendererSecurity);
  });
  markPerformanceAudit("security:session-handlers:end");

  const cancelActiveWork = () => {
    const current = services.runtime.getState();
    if (current.status === "youtube_downloading" || (current.status === "processing" && current.activeSourceType === "youtube")) {
      return services.getYouTubeQueueService().cancelActive();
    }

    if (current.status === "processing") {
      return services.getTranscriptionWorkflow().cancelActiveTranscription();
    }

    return false;
  };

  const overlay = new OverlayController({
    runtime: services.runtime,
    textInsertion: services.getTextInsertionService,
    show: showOverlayWindow,
    hide: () => { overlayWindow?.hide(); },
    flowPreview: (choice) => services.getTranscriptionWorkflow().chooseFlowPreview(choice)
  });
  overlayController = overlay;
  const handleRecordingToggle = () => overlay.toggleRecording();
  const handleOverlayShortcut = () => overlay.open();

  const holdToTalk = new HoldToTalk({
    setupComplete: () => {
      const { phase } = deriveOnboardingDisplayState(services.settingsService.getSettings(), microphoneStatus());
      return phase === "needs_first_transcript" || phase === "activated";
    },
    begin: () => { void overlay.beginHold(); },
    end: () => overlay.endHold(),
    test: (pressed) => services.runtime.sendTo("main", IPC_CHANNELS.holdKeyPressed, pressed)
  });
  services.holdKey.onDown = () => holdToTalk.press();
  services.holdKey.onUp = () => holdToTalk.release();
  // A key that is ready to be held must not wait for the floating window to load.
  services.runtime.on(RUNTIME_STATE_EVENT, () => {
    if (!isQuitting && services.runtime.getState().holdKey?.status === "ready") ensureOverlayWindow(services);
  });

  let callWindow: BrowserWindow | null = null;
  let callWindowMode: CallWindowMode | null = null;
  const syncCallWindow = () => {
    if (isQuitting) return;
    const call = services.runtime.getState().call;
    const mode = call?.recording ? "recording" : call?.suggestion ? "suggestion" : null;
    if (mode === callWindowMode) return;
    callWindowMode = mode;
    if (!mode) {
      // Call state lives in the main process, so a hidden call window holds nothing worth a renderer.
      if (callWindow && !callWindow.isDestroyed()) callWindow.destroy();
      callWindow = null;
      return;
    }
    if (!callWindow || callWindow.isDestroyed()) {
      callWindow = createCallWindow();
      services.runtime.setWindow("call", callWindow);
      const created = callWindow;
      created.once("ready-to-show", () => {
        if (!callWindowMode || created.isDestroyed()) return;
        placeCallWindow(created, callWindowMode);
        created.showInactive();
      });
      return;
    }
    placeCallWindow(callWindow, mode);
    callWindow.showInactive();
  };
  services.runtime.on(RUNTIME_STATE_EVENT, syncCallWindow);

  const handleTrayRecordingAction = async () => {
    const current = services.runtime.getState();
    if (isWorking(current.status)) {
      cancelActiveWork();
      return;
    }

    if (isRecording(current.status) && !current.overlaySession) {
      // A main-window recording stops in place, without bringing up the floating window.
      ensureOverlayWindow(services);
      services.runtime.requestRecordingToggle();
      return;
    }

    await handleRecordingToggle();
  };

  const shortcutManager = new ShortcutManager({
    onRecordingToggle: () => void handleRecordingToggle(),
    onOverlayOpen: () => void handleRecordingToggle(),
    onEscape: () => services.runtime.requestRecordingCancel(),
    onUndo: () => services.runtime.requestRecordingUndo()
  });
  // Esc and Cmd-Z stay with whatever app the user moved to; Meluli borrows them only
  // while the user is still where they dictate, and a cancel there can be undone.
  let undoHome: number | null = null;
  const claimDictationKeys = () => {
    const { status, activeSourceType, overlaySession } = services.runtime.getState();
    const insertion = services.getTextInsertionService();
    const onTarget = insertion.isAttentionOnTarget();
    const dictating = isDictating(status, activeSourceType);
    shortcutManager.setEscapeActive(dictating && Boolean(overlaySession) && onTarget);
    // Canceling clears the target, so Undo stays with the app the cancel happened in.
    const undoable = services.runtime.getHeldRecording() === "canceled";
    undoHome = undoable ? undoHome ?? insertion.getFrontmostPid() : null;
    shortcutManager.setUndoActive(undoable && insertion.getFrontmostPid() === undoHome);
  };
  services.runtime.on(RUNTIME_STATE_EVENT, claimDictationKeys);
  services.getTextInsertionService().onFrontmostChanged = claimDictationKeys;
  powerMonitor.on("suspend", () => {
    services.runtime.requestRecordingInterrupt();
    void services.calls.suspend();
  });
  let systemShuttingDown = false;
  powerMonitor.on("shutdown", () => { systemShuttingDown = true; });

  const initialSettings = services.settingsService.getSettings();
  applyTheme(initialSettings.theme);
  try {
    markPerformanceAudit("shortcuts:register:start");
    shortcutManager.registerAll({
      recording: initialSettings.shortcut || DEFAULT_SHORTCUT,
      overlay: initialSettings.overlayShortcut || DEFAULT_OVERLAY_SHORTCUT
    });
    markPerformanceAudit("shortcuts:register:end");
  } catch {
    // The defaults stand in for this session only. The saved shortcuts stay, so a key combination
    // another app held at login comes back on the next launch.
    console.warn("[shortcuts] saved shortcuts are unavailable, using the defaults for now");
    try {
      shortcutManager.registerAll({
        recording: DEFAULT_SHORTCUT,
        overlay: DEFAULT_OVERLAY_SHORTCUT
      });
    } catch {
      // Another app holding a shortcut must not stop Meluli from opening.
      console.warn("[shortcuts] default shortcuts are unavailable");
    }
    markPerformanceAudit("shortcuts:register:fallback");
  }

  markPerformanceAudit("ipc:register:start");
  registerIpcHandlers({
    ...services,
    shortcutManager,
    // Electron installs once every window has closed, and Meluli's windows only hide on close.
    // The update is staged before anything is torn down, so one that cannot install leaves the app running.
    // The finish step is the driver's own: Electron's installs and relaunches, the native one quits onto its staged swap.
    installUpdate: () => quitSafely(() => services.updates.install(), () => services.updates.prepareInstall()),
    hideOverlay: hideOverlayWindow,
    setOverlaySize: (size) => { if (overlayWindow && !overlayWindow.isDestroyed()) resizeOverlayWindow(overlayWindow, size); },
    openOverlay: handleOverlayShortcut,
    retargetOverlay: () => overlay.retarget(),
    showMain: (view) => showMainWindow(view),
    reportMainWindow: (sender, state) => mainHost?.report(sender, state),
    applyTheme: (theme) => {
      applyTheme(theme);
      mainHost?.current?.setBackgroundColor(getWindowBackground());
    },
    isPackaged: app.isPackaged
  });
  markPerformanceAudit("ipc:register:end");

  markPerformanceAudit("main-window:create:start");
  mainHost = new MainWindowHost({
    create: (view) => createMainWindow(view),
    attach: (window) => {
      window.on("close", (event) => {
        if (isQuitting) return;
        event.preventDefault();
        mainHost?.hide();
      });
      services.runtime.setWindow("main", window);
    },
    // The renderer that started a recording owns its audio, and a running job reports to it.
    mustKeep: (window) => {
      const { status } = services.runtime.getState();
      return services.runtime.isRecordingOwner(window.webContents.id) || !isFree(status);
    },
    navigate: (view) => services.runtime.requestMainNavigation(view),
    isQuitting: () => isQuitting,
    releaseDelayMs: MAIN_RELEASE_MS
  });
  const firstMainWindow = mainHost.ensure();
  markPerformanceAudit("main-window:create:end");
  firstMainWindow.webContents.once("did-finish-load", () => {
    markPerformanceAudit("main-window:did-finish-load");
  });
  firstMainWindow.once("ready-to-show", () => {
    markPerformanceAudit("main-window:ready-to-show");
    schedulePerformanceAuditStop("startup-idle");
  });
  markPerformanceAudit("main-window:attached");
  showMainWindow();
  // Destroying the hidden main window must not end a menu bar app.
  app.on("window-all-closed", () => {});

  const tray = new TrayManager(services.runtime, {
    onToggleWindow: () => {
      toggleMainWindow();
    },
    onOpenView: (view) => showMainWindow(view),
    onToggleRecording: () => {
      void handleTrayRecordingAction();
    },
    onStopCall: () => {
      void services.calls.stop();
    },
    onQuit: () => {
      app.quit();
    }
  });
  markPerformanceAudit("tray:init:start");
  tray.init();
  markPerformanceAudit("tray:init:end");

  void services.holdKey.sync();
  services.updates.sync();
  void services.calls.initialize();
  app.on("browser-window-focus", () => services.holdKey.recheck());

  app.on("activate", () => {
    ensureDockVisibility();
    showMainWindow();
  });

  function quitSafely(finish: () => void, prepare?: () => boolean): void {
    const { status, activeSourceType } = services.runtime.getState();
    const dictationAtRisk = isDictating(status, activeSourceType)
      || services.runtime.getHeldRecording() === "failed";
    if (dictationAtRisk && !systemShuttingDown && dialog.showMessageBoxSync({
      type: "warning", message: he.quitLosesDictation,
      detail: services.recordings ? he.quitKeepsDictationDetail : he.quitLosesDictationDetail,
      buttons: [he.keepDictation, he.quitAnyway], defaultId: 0, cancelId: 0
    }) === 0) return;
    if (prepare && !prepare()) return;
    isQuitting = true;
    shortcutManager.dispose();
    disposeOverlaySnap?.();
    // Destroying renderer windows releases microphones/AudioContexts immediately.
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    // Destroying the windows no longer quits by itself (window-all-closed is handled), so a cleanup
    // that hangs or an update install that fails must not leave a process with no windows behind.
    setTimeout(() => app.exit(0), QUIT_DEADLINE_MS);
    const cleanup = Promise.allSettled([services.dispose(), stopPerformanceAudit("before-quit")]);
    void Promise.race([cleanup, new Promise((done) => setTimeout(done, QUIT_CLEANUP_MS))]).then(finish);
  }

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    quitSafely(() => app.quit());
  });
}

// Any startup that throws ends the app with a message. Before the window opens, a throw used to leave a
// process with no window that held the profile's single-instance lock, so every later launch handed over
// to it and nothing opened.
if (!refusedSwitch) void bootstrap().catch((error: unknown) => {
  console.error("[startup] failed", error);
  dialog.showErrorBox(APP_NAME, he.startupFailed);
  app.exit(1);
});
