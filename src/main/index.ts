import { app, BrowserWindow, dialog, powerMonitor, session } from "electron";
import { he } from "@shared/locale";
import { mkdirSync } from "node:fs";
import { resolveUserDataPath } from "./config/user-data";
import { APP_ID, APP_NAME, DEFAULT_OVERLAY_SHORTCUT, DEFAULT_SHORTCUT } from "@shared/constants";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import { microphoneStatus, registerIpcHandlers } from "./ipc/register";
import { createMainWindow, createOverlayWindow, positionOverlayWindow, resizeOverlayWindow, createCallWindow, placeCallWindow, type CallWindowMode } from "./window";
import { attachOverlaySnap } from "./overlay-snap";
import { applyTheme, getWindowBackground } from "./theme";
import { HoldToTalk } from "./hold-to-talk";
import { OverlayController } from "./overlay-controller";
import { TrayManager } from "./tray";
import { ShortcutManager } from "./shortcuts";
import { createAppServiceContainer } from "./services/container";
import { createAppIcon } from "./app-icon";
import { clearDevelopmentEnv, debugSwitchesAllowed, findRefusedSwitch } from "./launch-switches";
import {
  createRendererSecurityEnvironment,
  installSessionPermissionHandlers
} from "./security";
import {
  markPerformanceAudit,
  schedulePerformanceAuditStop,
  startPerformanceAudit,
  stopPerformanceAudit
} from "./perf-audit";

const refusedSwitch = app.isPackaged && !debugSwitchesAllowed()
  ? findRefusedSwitch([...process.argv, ...process.execArgv])
  : null;
if (refusedSwitch) {
  console.error(`[startup] refusing to run with --${refusedSwitch}`);
  app.exit(1);
}

// A shipped app must never accept the test doubles, which report a paste that did not happen.
if (app.isPackaged) clearDevelopmentEnv(process.env);

let mainWindow: BrowserWindow | null = null;
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

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }

  showMainWindow();
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
    if ((state.status === "idle" || state.status === "error") && !state.overlaySession) {
      void services.getTextInsertionService().captureCurrentTargetApplication(() => {
        const latest = services.runtime.getState();
        return (latest.status === "idle" || latest.status === "error") && !latest.overlaySession;
      });
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
  app.on("second-instance", showMainWindow);
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
  const rendererSecurity = createRendererSecurityEnvironment({
    isPackaged: app.isPackaged,
    rawDevServerUrl: process.env.ELECTRON_RENDERER_URL ?? null
  });

  markPerformanceAudit("security:session-handlers:start");
  installSessionPermissionHandlers(session.defaultSession, services.runtime, rendererSecurity);
  app.on("session-created", (createdSession) => {
    installSessionPermissionHandlers(createdSession, services.runtime, rendererSecurity);
  });
  markPerformanceAudit("security:session-handlers:end");

  const cancelActiveWork = () => {
    const current = services.runtime.getState();
    if (current.status === "youtube_downloading") {
      return services.getYouTubeQueueService().cancelActive();
    }

    if (current.status === "processing" && current.activeSourceType === "youtube") {
      return services.getYouTubeQueueService().cancelActive();
    }

    if (current.status === "processing") {
      return services.getTranscriptionWorkflow().cancelActiveTranscription();
    }

    return false;
  };

  overlayController = new OverlayController({
    runtime: services.runtime,
    textInsertion: services.getTextInsertionService,
    show: showOverlayWindow,
    hide: () => { overlayWindow?.hide(); }
  });
  const handleRecordingToggle = () => overlayController!.toggleRecording();
  const handleOverlayShortcut = () => overlayController!.open();

  const holdToTalk = new HoldToTalk({
    setupComplete: () => {
      const { phase } = deriveOnboardingDisplayState(services.settingsService.getSettings(), microphoneStatus());
      return phase === "needs_first_transcript" || phase === "activated";
    },
    begin: () => { void overlayController!.beginHold(); },
    end: () => overlayController!.endHold(),
    test: (pressed) => services.runtime.sendTo("main", IPC_CHANNELS.holdKeyPressed, pressed)
  });
  services.holdKey.onDown = () => holdToTalk.press();
  services.holdKey.onUp = () => holdToTalk.release();
  // A key that is ready to be held must not wait for the floating window to load.
  services.runtime.on("state", () => {
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
      callWindow?.hide();
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
  services.runtime.on("state", syncCallWindow);

  const handleTrayRecordingAction = async () => {
    const current = services.runtime.getState();
    if (current.status === "youtube_downloading" || current.status === "processing") {
      cancelActiveWork();
      return;
    }

    if ((current.status === "recording" || current.status === "paused") && !current.overlaySession) {
      // A main-window recording stops in place, without bringing up the floating window.
      ensureOverlayWindow(services);
      services.runtime.requestRecordingToggle();
      return;
    }

    await handleRecordingToggle();
  };

  const shortcutManager = new ShortcutManager({
    onRecordingToggle: () => {
      void handleRecordingToggle();
    },
    onOverlayOpen: () => {
      void handleRecordingToggle();
    },
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
    const dictating = status === "recording" || status === "paused" || (status === "processing" && activeSourceType === "microphone");
    shortcutManager.setEscapeActive(dictating && Boolean(overlaySession) && onTarget);
    // Canceling clears the target, so Undo stays with the app the cancel happened in.
    const undoable = services.runtime.getHeldRecording() === "canceled";
    undoHome = undoable ? undoHome ?? insertion.getFrontmostPid() : null;
    shortcutManager.setUndoActive(undoable && insertion.getFrontmostPid() === undoHome);
  };
  services.runtime.on("state", claimDictationKeys);
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
    services.settingsService.setSetting("shortcut", DEFAULT_SHORTCUT);
    services.settingsService.setSetting("overlayShortcut", DEFAULT_OVERLAY_SHORTCUT);
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
    database: services.database,
    runtime: services.runtime,
    settingsService: services.settingsService,
    getModelManager: services.getModelManager,
    getTranscriptionService: services.getTranscriptionService,
    getTranscriptionWorkflow: services.getTranscriptionWorkflow,
    getYouTubeQueueService: services.getYouTubeQueueService,
    shortcutManager,
    getTextInsertionService: services.getTextInsertionService,
    holdKey: services.holdKey,
    calls: services.calls,
    updates: services.updates,
    // Electron installs once every window has closed, and Meluli's windows only hide on close.
    installUpdate: () => quitSafely(() => services.updates.install()),
    hideOverlay: hideOverlayWindow,
    setOverlaySize: (size) => { if (overlayWindow && !overlayWindow.isDestroyed()) resizeOverlayWindow(overlayWindow, size); },
    openOverlay: handleOverlayShortcut,
    retargetOverlay: () => overlayController!.retarget(),
    showMain: (view) => {
      services.runtime.requestMainNavigation(view);
      showMainWindow();
    },
    applyTheme: (theme) => {
      applyTheme(theme);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(getWindowBackground());
    },
    isPackaged: app.isPackaged
  });
  markPerformanceAudit("ipc:register:end");

  markPerformanceAudit("main-window:create:start");
  mainWindow = createMainWindow();
  markPerformanceAudit("main-window:create:end");
  mainWindow.webContents.once("did-finish-load", () => {
    markPerformanceAudit("main-window:did-finish-load");
  });
  mainWindow.once("ready-to-show", () => {
    markPerformanceAudit("main-window:ready-to-show");
    schedulePerformanceAuditStop("startup-idle");
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
  });
  services.runtime.setWindow("main", mainWindow);
  markPerformanceAudit("main-window:attached");
  showMainWindow();

  const tray = new TrayManager(services.runtime, {
    onToggleWindow: () => {
      toggleMainWindow();
    },
    onOpenWorkspace: () => {
      services.runtime.requestMainNavigation("workspace");
      showMainWindow();
    },
    onOpenHistory: () => {
      services.runtime.requestMainNavigation("history");
      showMainWindow();
    },
    onOpenDictionary: () => {
      services.runtime.requestMainNavigation("dictionary");
      showMainWindow();
    },
    onOpenSettings: () => {
      services.runtime.requestMainNavigation("settings");
      showMainWindow();
    },
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
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
      mainWindow.on("close", (event) => {
        if (isQuitting) {
          return;
        }

        event.preventDefault();
        mainWindow?.hide();
      });
      services.runtime.setWindow("main", mainWindow);
    }

    showMainWindow();
  });

  function quitSafely(finish: () => void): void {
    const { status, activeSourceType } = services.runtime.getState();
    const dictationAtRisk = status === "recording" || status === "paused" || (status === "processing" && activeSourceType === "microphone")
      || services.runtime.getHeldRecording() === "failed";
    if (dictationAtRisk && !systemShuttingDown && dialog.showMessageBoxSync({
      type: "warning", message: he.quitLosesDictation, detail: he.quitLosesDictationDetail,
      buttons: [he.keepDictation, he.quitAnyway], defaultId: 0, cancelId: 0
    }) === 0) return;
    isQuitting = true;
    shortcutManager.dispose();
    disposeOverlaySnap?.();
    // Destroying renderer windows releases microphones/AudioContexts immediately.
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    void Promise.allSettled([services.dispose(), stopPerformanceAudit("before-quit")]).then(finish);
  }

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    quitSafely(() => app.quit());
  });
}

if (!refusedSwitch) void bootstrap();
