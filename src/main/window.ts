import { app, BrowserWindow, nativeTheme, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE } from "@shared/constants";
import { createAppIcon } from "./app-icon";
import { getCurrentTheme, getWindowBackground } from "./theme";
import {
  canEnableSandboxedPreload,
  createRendererSecurityEnvironment,
  isTrustedRendererUrl,
  RENDERER_ENTRY_PATH
} from "./security";
import type { OverlayPosition, OverlaySize } from "@shared/types";
import type { AppWindowRole } from "./runtime";
import { clampOverlayPosition, presetOverlayPosition } from "./overlay-position";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERLAY_WINDOW_SIZES: Record<OverlaySize, { width: number; height: number }> = {
  compact: { width: 320, height: 60 },
  expanded: { width: 320, height: 148 }
};
const positionedOverlays = new WeakSet<BrowserWindow>();
export type CallWindowMode = "suggestion" | "recording";
const CALL_WINDOW_SIZES: Record<CallWindowMode, { width: number; height: number }> = {
  suggestion: { width: 340, height: 156 },
  recording: { width: 240, height: 60 }
};

function getRendererSecurityEnvironment() {
  return createRendererSecurityEnvironment({
    isPackaged: app.isPackaged,
    rawDevServerUrl: process.env.ELECTRON_RENDERER_URL ?? null
  });
}

function loadRendererWindow(window: BrowserWindow, mode: AppWindowRole): void {
  const environment = getRendererSecurityEnvironment();
  if (!app.isPackaged && environment.devServerUrl) {
    const url = new URL(environment.devServerUrl.toString());
    url.searchParams.set("window", mode);
    url.searchParams.set("theme", getCurrentTheme());
    void window.loadURL(url.toString());
    return;
  }

  void window.loadFile(RENDERER_ENTRY_PATH, {
    query: {
      window: mode,
      theme: getCurrentTheme()
    }
  });
}

function applyWindowSecurity(window: BrowserWindow, role: AppWindowRole): void {
  const environment = getRendererSecurityEnvironment();

  window.webContents.setWindowOpenHandler(() => ({
    action: "deny"
  }));

  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (isTrustedRendererUrl(targetUrl, role, environment)) {
      return;
    }

    event.preventDefault();
  });
}

function createWindowPreferences() {
  return {
    preload: join(__dirname, "../preload/index.cjs"),
    sandbox: canEnableSandboxedPreload(),
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    // Trusted local dictation can start from a native shortcut. Microphone
    // access still goes through the separate OS and session permission checks.
    autoplayPolicy: "no-user-gesture-required"
  } as const;
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: DEFAULT_WINDOW_SIZE.width,
    height: DEFAULT_WINDOW_SIZE.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: getWindowBackground(),
    icon: createAppIcon(),
    webPreferences: createWindowPreferences(),
    show: false
  });

  applyWindowSecurity(window, "main");

  const syncBackground = () => window.setBackgroundColor(getWindowBackground());
  nativeTheme.on("updated", syncBackground);
  window.once("closed", () => nativeTheme.off("updated", syncBackground));

  window.webContents.on("before-input-event", (event, input) => {
    if (
      process.platform === "darwin" &&
      input.type === "keyDown" &&
      input.meta &&
      !input.alt &&
      !input.control &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on("ready-to-show", () => {
    window.show();
  });

  loadRendererWindow(window, "main");

  return window;
}

export function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...OVERLAY_WINDOW_SIZES.compact,
    show: false,
    type: "panel",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    movable: true,
    roundedCorners: false,
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    icon: createAppIcon(),
    webPreferences: createWindowPreferences()
  });

  applyWindowSecurity(window, "overlay");

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "floating");
  window.setFullScreenable(false);

  loadRendererWindow(window, "overlay");

  return window;
}

/** Never takes keyboard focus, so clicking it leaves the user typing in the call's chat. */
export function createCallWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...CALL_WINDOW_SIZES.suggestion,
    show: false,
    type: "panel",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    movable: false,
    roundedCorners: false,
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    icon: createAppIcon(),
    webPreferences: createWindowPreferences()
  });

  applyWindowSecurity(window, "call");

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "floating");

  loadRendererWindow(window, "call");

  return window;
}

export function placeCallWindow(window: BrowserWindow, mode: CallWindowMode): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = CALL_WINDOW_SIZES[mode];
  window.setBounds({ ...size, x: workArea.x + workArea.width - size.width - 12, y: workArea.y + 12 }, false);
}

// The capsule grows away from the nearest screen edge, so it never jumps under the cursor.
export function resizeOverlayWindow(window: BrowserWindow, size: OverlaySize): void {
  const bounds = window.getBounds();
  const target = OVERLAY_WINDOW_SIZES[size];
  if (bounds.width === target.width && bounds.height === target.height) return;
  const { workArea } = screen.getDisplayMatching(bounds);
  const inLowerHalf = bounds.y + bounds.height / 2 > workArea.y + workArea.height / 2;
  const next = {
    ...target,
    x: bounds.x + Math.round((bounds.width - target.width) / 2),
    y: inLowerHalf ? bounds.y + bounds.height - target.height : bounds.y
  };
  window.setBounds({ ...next, ...clampOverlayPosition(next, workArea) }, false);
}

export function positionOverlayWindow(window: BrowserWindow, preset: OverlayPosition = "last"): void {
  const bounds = window.getBounds();
  if (preset !== "last") {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // Placed at its resting size, since the last session may have left it expanded.
    const size = OVERLAY_WINDOW_SIZES.compact;
    const position = clampOverlayPosition({ ...size, ...presetOverlayPosition(preset, size, workArea) }, workArea);
    window.setBounds({ ...size, ...position }, false);
    positionedOverlays.add(window);
    return;
  }
  if (!positionedOverlays.has(window)) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const x = display.workArea.x + (display.workArea.width - bounds.width) / 2;
    const y = display.workArea.y + display.workArea.height - bounds.height - 24;
    const position = clampOverlayPosition({ ...bounds, x, y }, display.workArea);
    window.setPosition(position.x, position.y, false);
    positionedOverlays.add(window);
    return;
  }
  const display = screen.getDisplayMatching(bounds);
  const position = clampOverlayPosition(bounds, display.workArea);
  if (position.x !== bounds.x || position.y !== bounds.y) window.setPosition(position.x, position.y, false);
}
