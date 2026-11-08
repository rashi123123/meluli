import { BrowserWindow, nativeTheme, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE } from "@shared/constants";
import { WINDOW_ROLE_QUERY_KEY } from "@shared/window-role";
import { createAppIcon } from "./app-icon";
import { getCurrentTheme, getWindowBackground } from "./theme";
import { appRendererSecurity, isTrustedRendererUrl, RENDERER_ENTRY_PATH } from "./security";
import type { MainView, OverlayPosition, OverlaySize } from "@shared/types";
import type { AppWindowRole } from "@shared/window-role";
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

function loadRendererWindow(window: BrowserWindow, mode: AppWindowRole, view: MainView | null = null): void {
  const environment = appRendererSecurity();
  const query: Record<string, string> = { [WINDOW_ROLE_QUERY_KEY]: mode, theme: getCurrentTheme(), ...(view ? { view } : {}) };
  if (environment.devServerUrl) {
    const url = new URL(environment.devServerUrl.toString());
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void window.loadURL(url.toString());
    return;
  }

  void window.loadFile(RENDERER_ENTRY_PATH, { query });
}

function applyWindowSecurity(window: BrowserWindow, role: AppWindowRole): void {
  const environment = appRendererSecurity();

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
    // The preload uses only contextBridge and ipcRenderer.
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    // Trusted local dictation can start from a native shortcut. Microphone
    // access still goes through the separate OS and session permission checks.
    autoplayPolicy: "no-user-gesture-required"
  } as const;
}

/** `view` opens a recreated window on that screen, since a navigation sent before it loads is lost. */
export function createMainWindow(view: MainView | null = null): BrowserWindow {
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
      // Through the close handler, so Cmd+W hides the same way as the close button.
      window.close();
    }
  });

  window.on("ready-to-show", () => {
    window.show();
  });

  loadRendererWindow(window, "main", view);

  return window;
}

/** A borderless panel that floats over every space, full-screen apps included. */
function createFloatingPanel(
  role: "overlay" | "call",
  size: { width: number; height: number },
  behaviour: { focusable: boolean; movable: boolean }
): BrowserWindow {
  const window = new BrowserWindow({
    ...size,
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
    ...behaviour,
    roundedCorners: false,
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    icon: createAppIcon(),
    webPreferences: createWindowPreferences()
  });

  applyWindowSecurity(window, role);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "floating");
  return window;
}

export function createOverlayWindow(): BrowserWindow {
  const window = createFloatingPanel("overlay", OVERLAY_WINDOW_SIZES.compact, { focusable: true, movable: true });
  window.setFullScreenable(false);
  loadRendererWindow(window, "overlay");
  return window;
}

/** Never takes keyboard focus, so clicking it leaves the user typing in the call's chat. */
export function createCallWindow(): BrowserWindow {
  const window = createFloatingPanel("call", CALL_WINDOW_SIZES.suggestion, { focusable: false, movable: false });
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
    // First show in "last" mode: there is no last place yet, so it starts where the "bottom" preset puts it.
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const position = clampOverlayPosition({ ...bounds, ...presetOverlayPosition("bottom", bounds, workArea) }, workArea);
    window.setPosition(position.x, position.y, false);
    positionedOverlays.add(window);
    return;
  }
  const display = screen.getDisplayMatching(bounds);
  const position = clampOverlayPosition(bounds, display.workArea);
  if (position.x !== bounds.x || position.y !== bounds.y) window.setPosition(position.x, position.y, false);
}
