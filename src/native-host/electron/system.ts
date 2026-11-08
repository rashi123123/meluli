// The rest of the Electron surface the app uses: screen, globalShortcut, systemPreferences, shell,
// powerMonitor, nativeTheme, dialog, clipboard, Notification, safeStorage, autoUpdater (ElectronUpdater.swift),
// and contentTracing, which has no native counterpart.
import { EventEmitter } from "../node/events";
import { Buffer } from "../node/buffer";
import { writeFileSync } from "../node/fs";
import { call, onHost, post, reportUncaught, ui } from "./bridge";
import { app, ElectronEvent } from "./app";
import type { BrowserWindow } from "./windows";

interface Point { x: number; y: number }
interface Rectangle extends Point { width: number; height: number }
interface Display { id: number; bounds: Rectangle; workArea: Rectangle; scaleFactor: number; [key: string]: unknown }

// ---------------------------------------------------------------------------------------------
// screen

function distanceTo(rect: Rectangle, point: Point): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

class Screen extends EventEmitter {
  getAllDisplays(): Display[] { return ui<Display[]>("screenDisplays"); }
  getPrimaryDisplay(): Display { return this.getAllDisplays()[0]; }
  getCursorScreenPoint(): Point { return ui<Point>("screenCursor"); }
  getDisplayNearestPoint(point: Point): Display {
    const displays = this.getAllDisplays();
    let best = displays[0], bestDistance = Infinity;
    for (const display of displays) {
      const distance = distanceTo(display.bounds, point);
      if (distance < bestDistance) { best = display; bestDistance = distance; }
    }
    return best;
  }
  /** The display the rectangle overlaps most; the nearest one when it overlaps none. */
  getDisplayMatching(rect: Rectangle): Display {
    const displays = this.getAllDisplays();
    let best: Display | null = null, bestArea = 0;
    for (const display of displays) {
      const b = display.bounds;
      const width = Math.min(rect.x + rect.width, b.x + b.width) - Math.max(rect.x, b.x);
      const height = Math.min(rect.y + rect.height, b.y + b.height) - Math.max(rect.y, b.y);
      const area = width > 0 && height > 0 ? width * height : 0;
      if (area > bestArea) { best = display; bestArea = area; }
    }
    return best ?? this.getDisplayNearestPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }
  screenToDipPoint(point: Point): Point { return point; }
  dipToScreenPoint(point: Point): Point { return point; }
}

export const screen = new Screen();
onHost("screen", (event: { type: string; display: Display; changedMetrics?: string[] }) => {
  if (event.type === "display-metrics-changed") screen.emit(event.type, new ElectronEvent(), event.display, event.changedMetrics ?? []);
  else screen.emit(event.type, new ElectronEvent(), event.display);
});

// ---------------------------------------------------------------------------------------------
// globalShortcut

const shortcuts = new Map<string, () => void>();

export const globalShortcut = {
  /** False when another app holds the shortcut; throws on an accelerator it cannot parse, as Electron does. */
  register(accelerator: string, callback: () => void): boolean {
    if (shortcuts.has(accelerator)) return false;
    const registered = ui<boolean>("shortcutRegister", accelerator);
    if (registered) shortcuts.set(accelerator, callback);
    return registered;
  },
  registerAll(accelerators: string[], callback: () => void): void {
    for (const accelerator of accelerators) globalShortcut.register(accelerator, callback);
  },
  isRegistered(accelerator: string): boolean { return shortcuts.has(accelerator); },
  unregister(accelerator: string): void {
    if (!shortcuts.delete(accelerator)) return;
    post("shortcutUnregister", accelerator);
  },
  unregisterAll(): void {
    if (shortcuts.size === 0) return;
    shortcuts.clear();
    post("shortcutUnregisterAll");
  }
};

onHost("shortcut", (accelerator: string) => {
  const callback = shortcuts.get(accelerator);
  if (!callback) return;
  try { callback(); } catch (error) { reportUncaught(error); }
});

// ---------------------------------------------------------------------------------------------
// systemPreferences

type MediaStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export const systemPreferences = Object.assign(new EventEmitter(), {
  isTrustedAccessibilityClient: (prompt: boolean): boolean => ui<boolean>("accessibilityTrusted", prompt === true),
  getAnimationSettings: (): { shouldRenderRichAnimation: boolean; scrollAnimationsEnabledBySystem: boolean; prefersReducedMotion: boolean } =>
    ui("animationSettings"),
  getMediaAccessStatus: (type: "microphone" | "camera" | "screen"): MediaStatus => ui<MediaStatus>("mediaAccessStatus", type),
  askForMediaAccess: (type: "microphone" | "camera"): Promise<boolean> => call<boolean>("askForMediaAccess", type),
  getUserDefault: (_key: string, _type: string): unknown => undefined,
  isDarkMode: (): boolean => nativeTheme.shouldUseDarkColors
});

// ---------------------------------------------------------------------------------------------
// shell

export const shell = {
  openExternal: (url: string, _options?: unknown): Promise<void> =>
    ui<boolean>("shellOpenExternal", url) ? Promise.resolve() : Promise.reject(new Error(`Failed to open: ${url}`)),
  /** Resolves to "" on success and to an error message otherwise, as Electron does. */
  openPath: (path: string): Promise<string> => Promise.resolve(ui<string>("shellOpenPath", path)),
  showItemInFolder: (path: string): void => post("shellShowItemInFolder", path),
  beep: (): void => post("shellBeep"),
  trashItem: (_path: string): Promise<void> => Promise.reject(new Error("shell.trashItem is not available in the native host"))
};

// ---------------------------------------------------------------------------------------------
// powerMonitor

export const powerMonitor = Object.assign(new EventEmitter(), {
  getCurrentThermalState: (): string => ui<string>("thermalState"),
  getSystemIdleTime: (): number => Math.floor(ui<number>("idleTime")),
  getSystemIdleState: (threshold: number): "active" | "idle" => (powerMonitor.getSystemIdleTime() >= threshold ? "idle" : "active"),
  isOnBatteryPower: (): boolean => false,
  get onBatteryPower(): boolean { return false; }
});
onHost("power", (type: string) => powerMonitor.emit(type, new ElectronEvent()));

// ---------------------------------------------------------------------------------------------
// nativeTheme

class NativeTheme extends EventEmitter {
  private source: "system" | "light" | "dark" = "system";
  private dark: boolean | null = null;
  get themeSource(): "system" | "light" | "dark" { return this.source; }
  set themeSource(source: "system" | "light" | "dark") {
    this.source = source;
    post("themeSet", source);
    // The appearance change also arrives as a "theme" event; this answers shouldUseDarkColors at once.
    this.dark = source === "system" ? null : source === "dark";
  }
  get shouldUseDarkColors(): boolean { return (this.dark ??= ui<boolean>("themeIsDark")); }
  get shouldUseHighContrastColors(): boolean { return false; }
  get shouldUseInvertedColorScheme(): boolean { return false; }
  get inForcedColorsMode(): boolean { return false; }
  /** @internal */ changed(dark: boolean): void {
    if (this.dark === dark) return;
    this.dark = dark;
    this.emit("updated");
  }
}

export const nativeTheme = new NativeTheme();
onHost("theme", (dark: boolean) => nativeTheme.changed(dark === true));

// ---------------------------------------------------------------------------------------------
// dialog

function splitWindow<T>(windowOrOptions: BrowserWindow | T | undefined, options: T | undefined): [number | null, T] {
  if (options !== undefined) return [(windowOrOptions as BrowserWindow | undefined)?.id ?? null, options];
  return [null, (windowOrOptions ?? {}) as T];
}

export const dialog = {
  showMessageBoxSync(windowOrOptions: BrowserWindow | Record<string, unknown>, maybeOptions?: Record<string, unknown>): number {
    const [windowId, options] = splitWindow(windowOrOptions, maybeOptions);
    return ui<number>("messageBoxSync", options, windowId);
  },
  showMessageBox(windowOrOptions: BrowserWindow | Record<string, unknown>, maybeOptions?: Record<string, unknown>) {
    const [windowId, options] = splitWindow(windowOrOptions, maybeOptions);
    return call<{ response: number; checkboxChecked: boolean }>("messageBox", options, windowId);
  },
  showOpenDialog(windowOrOptions: BrowserWindow | Record<string, unknown>, maybeOptions?: Record<string, unknown>) {
    const [windowId, options] = splitWindow(windowOrOptions, maybeOptions);
    return call<{ canceled: boolean; filePaths: string[] }>("openDialog", options, windowId);
  },
  showSaveDialog(windowOrOptions: BrowserWindow | Record<string, unknown>, maybeOptions?: Record<string, unknown>) {
    const [windowId, options] = splitWindow(windowOrOptions, maybeOptions);
    return call<{ canceled: boolean; filePath: string }>("saveDialog", options, windowId);
  },
  showErrorBox(title: string, content: string): void {
    ui("messageBoxSync", { type: "error", message: title, detail: content, buttons: ["OK"] }, null);
  }
};

// ---------------------------------------------------------------------------------------------
// clipboard

export const clipboard = {
  writeText: (text: string): void => { ui("clipboardWriteText", String(text)); },
  readText: (): string => ui<string>("clipboardReadText"),
  clear: (): void => { ui("clipboardWriteText", ""); }
};

// ---------------------------------------------------------------------------------------------
// Notification

const notifications = new Map<string, Notification>();

export class Notification extends EventEmitter {
  static isSupported(): boolean { return true; }
  private readonly id = __native.randomUUID();
  constructor(private readonly options: { title?: string; subtitle?: string; body?: string; silent?: boolean } = {}) { super(); }
  get title(): string { return this.options.title ?? ""; }
  get body(): string { return this.options.body ?? ""; }
  show(): void {
    notifications.set(this.id, this);
    post("notificationShow", { title: this.options.title ?? "", subtitle: this.options.subtitle, body: this.options.body ?? "", silent: this.options.silent === true }, this.id);
  }
  close(): void {
    notifications.delete(this.id);
    post("notificationClose", this.id);
    this.emit("close", new ElectronEvent());
  }
}

onHost("notification", (event: { type: string; id: string; error?: string }) => {
  const notification = notifications.get(event.id);
  if (!notification) return;
  if (event.type === "click") {
    notification.emit("click", new ElectronEvent());
    notifications.delete(event.id);
  } else if (event.type === "show") {
    notification.emit("show", new ElectronEvent());
  } else if (event.type === "failed") {
    notifications.delete(event.id);
    notification.emit("failed", new ElectronEvent(), event.error ?? "");
  }
});

// ---------------------------------------------------------------------------------------------
// safeStorage (HostSafeStorage in ElectronApp.swift: Electron's v10 format, its own keychain item)

export const safeStorage = {
  isEncryptionAvailable: (): boolean => __native.safeStorageAvailable() === true,
  isAsyncEncryptionAvailable: (): Promise<boolean> => Promise.resolve(__native.safeStorageAvailable() === true),
  encryptString: (text: string): Buffer => Buffer.from(__native.safeStorageEncrypt(String(text))),
  decryptString: (data: Uint8Array): string => {
    if (!(data instanceof Uint8Array)) throw new TypeError("Expected the first argument of decryptString() to be a buffer");
    return __native.safeStorageDecrypt(data);
  },
  getSelectedStorageBackend: (): string => "keychain",
  setUsePlainTextEncryption: (_use: boolean): void => {}
};

// ---------------------------------------------------------------------------------------------
// autoUpdater: Squirrel.Mac's JSON feed, carried out by the host (ElectronUpdater.swift). As with
// Squirrel, the feed names the newest release and the archive to move to; the host downloads it and
// accepts the app inside only if it is signed to this app's designated requirement. UpdateService
// has already refused downgrades and archives from anywhere but this repository's release.

interface SquirrelFeed { currentRelease?: unknown; releases?: Array<{ version?: unknown; updateTo?: { version?: unknown; name?: unknown; notes?: unknown; pub_date?: unknown; url?: unknown } }> }

class AutoUpdater extends EventEmitter {
  private feed = "";
  private checking = false;
  private downloaded: { path: string; version: string } | null = null;
  private staged = false;

  setFeedURL(options: { url: string } | string): void {
    this.feed = typeof options === "string" ? options : options.url;
    // Electron refuses a feed in an app it cannot verify; so does this, with the host's reason.
    const reason = ui<string | null>("updaterUnavailableReason");
    if (reason) throw new Error(reason);
  }
  getFeedURL(): string { return this.feed; }

  checkForUpdates(): void {
    if (this.checking || this.downloaded) return;
    this.checking = true;
    this.emit("checking-for-update");
    void this.check().catch((error: unknown) => this.emit("error", error instanceof Error ? error : new Error(String(error))))
      .finally(() => { this.checking = false; });
  }

  private async check(): Promise<void> {
    if (!this.feed) throw new Error("Update URL is not set");
    const response = await fetch(this.feed, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Update check failed. The server sent an invalid response (${response.status}).`);
    const feed = await response.json() as SquirrelFeed;
    const current = typeof feed.currentRelease === "string" ? feed.currentRelease : "";
    if (!current || current === app.getVersion()) {
      this.emit("update-not-available");
      return;
    }
    const target = feed.releases?.find((release) => release.version === current)?.updateTo;
    if (!target || typeof target.url !== "string") throw new Error("Update check failed. The feed does not name the current release's archive.");
    this.emit("update-available");
    const result = await call<{ path?: string; error?: string }>("updaterDownload", target.url, current);
    if (!result?.path) throw new Error(result?.error ?? "The update could not be downloaded");
    this.downloaded = { path: result.path, version: current };
    const date = typeof target.pub_date === "string" ? new Date(target.pub_date) : new Date();
    this.emit("update-downloaded", new ElectronEvent(), typeof target.notes === "string" ? target.notes : "",
      typeof target.name === "string" ? target.name : current, date, target.url);
  }

  /** Starts the swap that waits for this process to exit. Throws, and forgets the download, if it cannot. */
  prepareInstall(): void {
    if (this.staged) return;
    if (!this.downloaded) throw new Error("No update has been downloaded");
    try {
      ui("updaterInstall", this.downloaded.path, this.downloaded.version);
    } catch (error) {
      this.downloaded = null;
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.staged = true;
  }

  quitAndInstall(): void {
    if (!this.downloaded) return;
    try {
      this.prepareInstall();
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    app.quit();
  }
}

export const autoUpdater = new AutoUpdater();

// ---------------------------------------------------------------------------------------------
// contentTracing: Chromium tracing has no WebKit counterpart. The audit still writes its marks.

export const contentTracing = {
  startRecording: (_options: unknown): Promise<void> => Promise.resolve(),
  stopRecording: (path?: string): Promise<string> => {
    if (path) writeFileSync(path, JSON.stringify({ traceEvents: [], metadata: { host: "meluli-native" } }));
    return Promise.resolve(path ?? "");
  },
  getCategories: (): Promise<string[]> => Promise.resolve([])
};
