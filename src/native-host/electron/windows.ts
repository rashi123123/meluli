// BrowserWindow, webContents, ipcMain and the default session over the native host. The windows
// themselves live in Swift (ElectronWindows.swift); these objects mirror Electron's API and events.
//
// Pages are served at meluli://app/<path>. The app's code expects Electron's file:// URLs for
// out/renderer (security.ts compares them), so every URL it sees is mapped to the file URL that
// loadFile would have produced for the same file, query and hash.
import { EventEmitter } from "../node/events";
import { dirname, join, relative, resolve } from "../node/path";
import { fileURLToPath, format } from "../node/url";
import { decodePayload, encodePayload, onHost, post, reportUncaught, ui } from "./bridge";
import { app, ElectronEvent } from "./app";
import { allWindows, windows } from "./window-list";

/** out/renderer, beside out/main/index.js, whose URL Swift sets as __meluliMainUrl. */
export const rendererRoot = resolve(dirname(fileURLToPath(String((globalThis as Record<string, unknown>).__meluliMainUrl))), "../renderer");
/** HostNames.pageScheme and pageHost in native/host/HostNames.swift. */
const PAGE_SCHEME = "meluli:";
const PAGE_HOST = "app";

/** meluli://app/index.html?x#y → file:///…/out/renderer/index.html?x#y, built as loadFile builds it. */
export function toFileUrl(appUrl: string): string {
  let parsed: URL;
  try { parsed = new URL(appUrl); } catch { return appUrl; }
  if (parsed.protocol !== PAGE_SCHEME || parsed.host !== PAGE_HOST) return appUrl;
  let path: string;
  try { path = decodeURIComponent(parsed.pathname); } catch { return appUrl; }
  const file = join(rendererRoot, path === "/" || path === "" ? "index.html" : path);
  return format({ protocol: "file:", slashes: true, pathname: file }) + parsed.search + parsed.hash;
}

interface Rectangle { x: number; y: number; width: number; height: number }

const byContents = new WeakMap<WebContents, BrowserWindow>();
let nextWindowId = 1;
let nextContentsId = 1;


// ---------------------------------------------------------------------------------------------
// Frames and webContents

class WebFrameMain {
  constructor(private readonly contents: WebContents, public url: string, readonly isMain: boolean) {}
  readonly routingId = 1;
  readonly processId = 1;
  readonly frameTreeNodeId = 1;
  get top(): WebFrameMain { return this.contents.mainFrame; }
  get parent(): WebFrameMain | null { return this.isMain ? null : this.contents.mainFrame; }
  get frames(): WebFrameMain[] { return []; }
  get origin(): string { return this.url.startsWith("file:") ? "file://" : (() => { try { return new URL(this.url).origin; } catch { return "null"; } })(); }
  isDestroyed(): boolean { return this.contents.isDestroyed(); }
}

export class WebContents extends EventEmitter {
  readonly id = nextContentsId++;
  readonly mainFrame: WebFrameMain;
  private url = "";
  private loading = false;
  private destroyed = false;
  private pendingLoad: { resolve: () => void; reject: (error: Error) => void } | null = null;
  readonly session: Session;

  constructor(readonly windowId: number) {
    super();
    this.mainFrame = new WebFrameMain(this, "", true);
    this.session = session.defaultSession;
  }

  getURL(): string { return this.url; }
  getTitle(): string { return app.getName(); }
  isLoading(): boolean { return this.loading; }
  isLoadingMainFrame(): boolean { return this.loading; }
  isDestroyed(): boolean { return this.destroyed; }
  isCrashed(): boolean { return false; }
  getOSProcessId(): number { return 0; }
  getProcessId(): number { return 1; }
  // Swift refuses every new window, whatever the app's handler would say.
  setWindowOpenHandler(_handler: (details: unknown) => unknown): void {}
  setAudioMuted(_muted: boolean): void {}
  setBackgroundThrottling(_allowed: boolean): void {}
  openDevTools(): void {}
  closeDevTools(): void {}
  isDevToolsOpened(): boolean { return false; }
  reload(): void { this.window()?.reloadPage(); }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) throw new Error("Object has been destroyed");
    post("windowSend", this.windowId, channel, encodePayload(args));
  }

  private window(): BrowserWindow | undefined { return windows.get(this.windowId); }

  /** @internal */ beginLoad(): Promise<void> {
    this.pendingLoad?.reject(abortedError());
    this.loading = true;
    return new Promise((resolve, reject) => { this.pendingLoad = { resolve, reject }; });
  }

  /** @internal */ handle(event: Record<string, any>): void {
    switch (event.type) {
      case "did-start-loading":
        this.loading = true;
        this.emit("did-start-loading");
        this.emit("did-start-navigation", new ElectronEvent(), this.url, false, true);
        break;
      case "did-navigate":
        this.url = toFileUrl(String(event.url ?? ""));
        this.mainFrame.url = this.url;
        this.emit("did-navigate", new ElectronEvent(), this.url, 200, "OK");
        break;
      case "did-finish-load": {
        this.loading = false;
        this.emit("dom-ready", new ElectronEvent());
        this.emit("did-stop-loading");
        this.emit("did-finish-load", new ElectronEvent());
        const pending = this.pendingLoad;
        this.pendingLoad = null;
        pending?.resolve();
        break;
      }
      case "did-fail-load": {
        this.loading = false;
        // NSURLErrorCancelled is Chromium's ERR_ABORTED: a newer load replaced this one.
        const code = event.code === -999 ? -3 : Number(event.code ?? -2);
        const description = code === -3 ? "ERR_ABORTED" : String(event.message ?? "ERR_FAILED");
        this.emit("did-fail-load", new ElectronEvent(), code, description, this.url, true, 1, 1);
        const pending = this.pendingLoad;
        this.pendingLoad = null;
        pending?.reject(Object.assign(new Error(`${description} (${code}) loading '${this.url}'`), { code: description, errno: code, url: this.url }));
        break;
      }
      case "render-process-gone":
        this.loading = true;
        this.emit("render-process-gone", new ElectronEvent(), { reason: String(event.reason ?? "crashed"), exitCode: 0 });
        break;
      case "permission-request":
        session.defaultSession.handlePermissionRequest(this, event);
        break;
      case "ipc":
        dispatchIpc(this, event);
        break;
    }
  }

  /** @internal */ markDestroyed(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loading = false;
    this.pendingLoad?.reject(abortedError());
    this.pendingLoad = null;
    this.emit("destroyed");
  }
}

function abortedError(): Error {
  return Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED", errno: -3 });
}

// ---------------------------------------------------------------------------------------------
// BrowserWindow

/** The options Swift reads (WindowController.init in ElectronWindows.swift); a new key goes in both. Objects such as icon and webPreferences stay here. */
const WINDOW_OPTION_KEYS = [
  "width", "height", "x", "y", "minWidth", "minHeight", "frame", "type", "focusable", "resizable", "minimizable", "maximizable",
  "fullscreenable", "movable", "titleBarStyle", "trafficLightPosition", "title", "hasShadow", "hiddenInMissionControl",
  "skipTaskbar", "transparent", "backgroundColor", "acceptFirstMouse"
] as const;

export class BrowserWindow extends EventEmitter {
  static getAllWindows(): BrowserWindow[] { return allWindows(); }
  static getFocusedWindow(): BrowserWindow | null {
    const id = ui<number | null>("focusedWindow");
    return id === null || id === undefined ? null : windows.get(id) ?? null;
  }
  static fromWebContents(contents: WebContents): BrowserWindow | null { return byContents.get(contents) ?? null; }
  static fromId(id: number): BrowserWindow | null { return windows.get(id) ?? null; }

  readonly id = nextWindowId++;
  readonly webContents: WebContents;
  private destroyed = false;
  private visible = false;
  private alwaysOnTop = false;
  private title: string;

  constructor(options: Record<string, any> = {}) {
    super();
    const native: Record<string, unknown> = {};
    for (const key of WINDOW_OPTION_KEYS) if (options[key] !== undefined) native[key] = options[key];
    this.title = String(options.title ?? app.getName());
    this.webContents = new WebContents(this.id);
    windows.set(this.id, this);
    byContents.set(this.webContents, this);
    post("windowCreate", this.id, native);
    if (options.alwaysOnTop) this.setAlwaysOnTop(true);
    if (options.show !== false) this.show();
  }

  isDestroyed(): boolean { return this.destroyed; }
  private live(): void { if (this.destroyed) throw new TypeError("Object has been destroyed"); }

  loadFile(filePath: string, options: { query?: Record<string, string>; search?: string; hash?: string } = {}): Promise<void> {
    this.live();
    const path = relative(rendererRoot, resolve(filePath));
    if (path.startsWith("..") || path.startsWith("/")) {
      return Promise.reject(new Error(`ERR_FILE_NOT_FOUND (-6) loading '${filePath}': outside the app's pages`));
    }
    const search = options.query ? new URLSearchParams(options.query).toString() : (options.search ?? "").replace(/^\?/, "");
    const loaded = this.webContents.beginLoad();
    post("windowLoad", this.id, path, search);
    return loaded;
  }

  loadURL(url: string): Promise<void> {
    this.live();
    let parsed: URL;
    try { parsed = new URL(url); } catch { return Promise.reject(new Error(`ERR_INVALID_URL (-300) loading '${url}'`)); }
    if (parsed.protocol === "file:") {
      return this.loadFile(fileURLToPath(parsed.origin === "null" ? `file://${parsed.pathname}` : url), { search: parsed.search });
    }
    if (parsed.protocol === PAGE_SCHEME && parsed.host === PAGE_HOST) {
      return this.loadFile(join(rendererRoot, decodeURIComponent(parsed.pathname)), { search: parsed.search });
    }
    // The native app has no development server and no remote pages.
    return Promise.reject(new Error(`ERR_BLOCKED_BY_CLIENT (-20) loading '${url}'`));
  }

  /** @internal Swift reloads after the web content process ends; this is for webContents.reload(). */
  reloadPage(): void {
    const url = this.webContents.getURL();
    if (url) void this.loadURL(url).catch(() => {});
  }

  show(): void { this.live(); post("windowShow", this.id); this.setVisible(true); }
  showInactive(): void { this.live(); post("windowShowInactive", this.id); this.setVisible(true); }
  hide(): void { this.live(); post("windowHide", this.id); this.setVisible(false); }
  focus(): void { this.live(); post("windowFocus", this.id); this.setVisible(true); }
  blur(): void {}
  isVisible(): boolean { return !this.destroyed && ui<boolean>("windowIsVisible", this.id); }
  isMinimized(): boolean { return !this.destroyed && ui<boolean>("windowIsMinimized", this.id); }
  isFocused(): boolean { return !this.destroyed && ui<boolean>("windowIsFocused", this.id); }
  isFullScreen(): boolean { return false; }
  isMaximized(): boolean { return false; }
  minimize(): void { this.live(); post("windowMinimize", this.id); }
  restore(): void { this.live(); post("windowRestore", this.id); }
  moveTop(): void { this.live(); post("windowShowInactive", this.id); }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.emit(visible ? "show" : "hide");
  }

  getBounds(): Rectangle { this.live(); return ui<Rectangle>("windowGetBounds", this.id); }
  getContentBounds(): Rectangle { this.live(); return ui<Rectangle>("windowGetContentBounds", this.id); }
  getPosition(): [number, number] { const { x, y } = this.getBounds(); return [x, y]; }
  getSize(): [number, number] { const { width, height } = this.getBounds(); return [width, height]; }
  getContentSize(): [number, number] { const { width, height } = this.getContentBounds(); return [width, height]; }
  setBounds(bounds: Partial<Rectangle>, animate = false): void { this.live(); post("windowSetBounds", this.id, roundRect(bounds), animate); }
  setPosition(x: number, y: number, animate = false): void { this.setBounds({ x, y }, animate); }
  setSize(width: number, height: number, animate = false): void { this.setBounds({ width, height }, animate); }
  setContentBounds(bounds: Partial<Rectangle>, animate = false): void { this.setBounds(bounds, animate); }

  setBackgroundColor(color: string): void { this.live(); post("windowSetBackgroundColor", this.id, color); }
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen?: boolean } = {}): void {
    this.live(); post("windowSetVisibleOnAllWorkspaces", this.id, visible, options);
  }
  setAlwaysOnTop(flag: boolean, level: string = "floating", _relativeLevel = 0): void {
    this.live(); this.alwaysOnTop = flag; post("windowSetAlwaysOnTop", this.id, flag, level);
  }
  isAlwaysOnTop(): boolean { return this.alwaysOnTop; }
  setFullScreenable(flag: boolean): void { this.live(); post("windowSetFullScreenable", this.id, flag); }
  setTitle(title: string): void { this.live(); this.title = title; post("windowSetTitle", this.id, title); }
  getTitle(): string { return this.title; }
  setIgnoreMouseEvents(_ignore: boolean): void {}
  setContentProtection(_enabled: boolean): void {}
  setHasShadow(_flag: boolean): void {}
  setOpacity(_opacity: number): void {}
  setMenuBarVisibility(_visible: boolean): void {}
  setSkipTaskbar(_skip: boolean): void {}

  /** Asks first, as a person closing the window would; the "close" listeners may keep it. */
  close(): void {
    if (this.destroyed) return;
    const event = new ElectronEvent();
    this.emit("close", event);
    if (!event.defaultPrevented && !this.destroyed) this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    post("windowDestroy", this.id);
    windows.delete(this.id);
    this.visible = false;
    this.emit("closed");
    this.webContents.markDestroyed();
    if (windows.size === 0) app.windowsAllClosed();
  }

  /** @internal */ handle(event: Record<string, any>): void {
    if (this.destroyed) return;
    switch (event.type) {
      case "close-request": this.close(); break;
      case "focus":
        this.emit("focus");
        app.emit("browser-window-focus", new ElectronEvent(), this);
        break;
      case "blur":
        this.emit("blur");
        app.emit("browser-window-blur", new ElectronEvent(), this);
        break;
      case "will-move": this.emit("will-move", new ElectronEvent(), this.getBounds()); break;
      case "move": case "moved": case "resize": case "resized": this.emit(event.type); break;
      case "minimize": this.emit("minimize"); break;
      case "restore": this.emit("restore"); break;
      case "ready-to-show": this.emit("ready-to-show"); break;
      default: this.webContents.handle(event);
    }
  }
}

function roundRect(bounds: Partial<Rectangle>): Partial<Rectangle> {
  const result: Partial<Rectangle> = {};
  for (const key of ["x", "y", "width", "height"] as const) {
    const value = bounds[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.round(value);
  }
  return result;
}

onHost("window", (event: Record<string, any>) => {
  windows.get(Number(event.id))?.handle(event);
});

// ---------------------------------------------------------------------------------------------
// ipcMain

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
export interface IpcMainInvokeEvent {
  sender: WebContents;
  senderFrame: WebFrameMain | null;
  frameId: number;
  processId: number;
  type: "frame";
}

class IpcMain extends EventEmitter {
  private readonly handlers = new Map<string, InvokeHandler>();
  handle(channel: string, handler: InvokeHandler): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, handler);
  }
  handleOnce(channel: string, handler: InvokeHandler): void {
    this.handle(channel, (event, ...args) => { this.removeHandler(channel); return handler(event, ...args); });
  }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
  /** @internal */ handlerFor(channel: string): InvokeHandler | undefined { return this.handlers.get(channel); }
}

export const ipcMain = new IpcMain();

function dispatchIpc(contents: WebContents, message: Record<string, any>): void {
  const channel = String(message.channel ?? "");
  const reply = Number(message.reply ?? 0);
  const frameUrl = toFileUrl(String(message.frameUrl ?? ""));
  const senderFrame = message.mainFrame === true ? contents.mainFrame : new WebFrameMain(contents, frameUrl, false);
  if (message.mainFrame === true) contents.mainFrame.url = frameUrl;
  const event: IpcMainInvokeEvent = { sender: contents, senderFrame, frameId: senderFrame.isMain ? 1 : 2, processId: 1, type: "frame" };
  const answer = (ok: boolean, value: string) => { if (reply) post("ipcReply", contents.windowId, reply, ok, value); };

  let args: unknown[];
  try {
    const decoded = decodePayload(String(message.payload ?? "[]"));
    args = Array.isArray(decoded) ? decoded : [decoded];
  } catch (error) {
    answer(false, `Error invoking remote method '${channel}': ${String(error)}`);
    return;
  }

  if (!reply) {
    ipcMain.emit(channel, { ...event, returnValue: undefined, reply: (...values: unknown[]) => contents.send(channel, ...values) }, ...args);
    return;
  }
  const handler = ipcMain.handlerFor(channel);
  if (!handler) {
    answer(false, `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`);
    return;
  }
  Promise.resolve()
    .then(() => handler(event, ...args))
    .then((value) => {
      let encoded: string;
      try { encoded = encodePayload(value); } catch (error) {
        answer(false, `Error invoking remote method '${channel}': ${String(error)}`);
        return;
      }
      answer(true, encoded);
    }, (error) => {
      answer(false, `Error invoking remote method '${channel}': ${String(error)}`);
    })
    .catch(reportUncaught);
}

// ---------------------------------------------------------------------------------------------
// session

type PermissionRequestHandler = (contents: WebContents, permission: string, callback: (granted: boolean) => void, details: Record<string, unknown>) => void;
type PermissionCheckHandler = (contents: WebContents | null, permission: string, origin: string, details: Record<string, unknown>) => boolean;

export class Session extends EventEmitter {
  private requestHandler: PermissionRequestHandler | null = null;
  setPermissionRequestHandler(handler: PermissionRequestHandler | null): void { this.requestHandler = handler; }
  // Swift asks only for permission requests, which go to the request handler.
  setPermissionCheckHandler(_handler: PermissionCheckHandler | null): void {}
  setDevicePermissionHandler(_handler: unknown): void {}
  setDisplayMediaRequestHandler(_handler: unknown): void {}
  getUserAgent(): string { return "Meluli"; }
  setUserAgent(_agent: string): void {}
  clearCache(): Promise<void> { return Promise.resolve(); }
  clearStorageData(): Promise<void> { return Promise.resolve(); }
  setSpellCheckerEnabled(_enabled: boolean): void {}
  readonly webRequest = { onBeforeRequest: () => {}, onHeadersReceived: () => {}, onBeforeSendHeaders: () => {} };
  readonly protocol = { handle: () => {}, registerFileProtocol: () => false };

  /** @internal A page asked for the microphone (WebKit only asks for media). No handler means no. */
  handlePermissionRequest(contents: WebContents, request: Record<string, any>): void {
    const id = Number(request.request);
    let answered = false;
    const callback = (granted: boolean) => {
      if (answered) return;
      answered = true;
      post("permissionReply", id, granted === true);
    };
    if (!this.requestHandler) return callback(false);
    const requestingUrl = toFileUrl(String(request.requestingUrl ?? ""));
    try {
      this.requestHandler(contents, String(request.permission ?? "media"), callback, {
        isMainFrame: request.mainFrame === true,
        mediaTypes: Array.isArray(request.mediaTypes) ? request.mediaTypes : [],
        requestingUrl,
        securityOrigin: requestingUrl.startsWith("file:") ? "file:///" : requestingUrl
      });
    } catch (error) {
      reportUncaught(error);
      callback(false);
    }
  }
}

export const session = {
  defaultSession: new Session(),
  fromPartition: (_partition: string) => session.defaultSession
};
