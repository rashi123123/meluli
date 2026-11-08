// Electron's `app` over the native host: paths, identity, the single-instance lock, the Dock, login
// items and the quit sequence (before-quit → close windows → will-quit → quit → exit).
import { EventEmitter } from "../node/events";
import { join } from "../node/path";
import { onHost, post, ui } from "./bridge";
import { imageDescriptor, type NativeImage } from "./image";
import { allWindows } from "./window-list";

interface AppInfo {
  name: string; version: string; exe: string;
  home: string; appData: string; temp: string; desktop: string; documents: string; downloads: string;
  music: string; pictures: string; videos: string; logs: string; isInApplicationsFolder: boolean;
}

let info: AppInfo | null = null;
const appInfo = (): AppInfo => (info ??= ui<AppInfo>("appInfo"));

export class ElectronEvent {
  defaultPrevented = false;
  preventDefault(): void { this.defaultPrevented = true; }
}

class App extends EventEmitter {
  readonly isPackaged: boolean = __native.isPackaged === true;
  private name: string | null = null;
  private readonly paths = new Map<string, string>();
  private ready = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private quitting = false;
  readonly commandLine = {
    appendSwitch: (_name: string, _value?: string) => {},
    appendArgument: (_value: string) => {},
    hasSwitch: (_name: string) => false,
    getSwitchValue: (_name: string) => "",
    removeSwitch: (_name: string) => {}
  };

  readonly dock = {
    show: (): Promise<void> => { post("appSetActivationPolicy", "regular"); return Promise.resolve(); },
    hide: (): void => post("appSetActivationPolicy", "accessory"),
    isVisible: (): boolean => ui<boolean>("dockIsVisible"),
    setIcon: (image: NativeImage | string): void => post("dockSetIcon", imageDescriptor(image)),
    setBadge: (text: string): void => post("dockSetBadge", text),
    getBadge: (): string => "",
    bounce: (type: "critical" | "informational" = "informational"): number => { post("dockBounce", type); return 0; },
    cancelBounce: (_id: number): void => {},
    setMenu: (_menu: unknown): void => {}
  };

  constructor() {
    super();
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
    onHost("app", (event: { type: string; hasVisibleWindows?: boolean }) => {
      switch (event.type) {
        case "ready":
          this.ready = true;
          this.emit("will-finish-launching");
          this.emit("ready", new ElectronEvent(), {});
          this.resolveReady();
          break;
        case "activate":
          this.emit("activate", new ElectronEvent(), event.hasVisibleWindows === true);
          break;
        case "second-instance":
          this.emit("second-instance", new ElectronEvent(), [], process.cwd(), null);
          break;
        case "quit-request":
          // From ⌘Q, the Dock or a logout. For a logout macOS waits (see applicationShouldTerminate).
          this.quit();
          break;
      }
    });
  }

  whenReady(): Promise<void> { return this.readyPromise; }
  isReady(): boolean { return this.ready; }

  getName(): string { return this.name ?? appInfo().name; }
  setName(name: string): void { this.name = name; }
  get applicationName(): string { return this.getName(); }
  getVersion(): string { return appInfo().version; }
  getAppPath(): string { return join(process.resourcesPath, "app"); }
  getLocale(): string { return Intl.DateTimeFormat().resolvedOptions().locale; }
  getSystemLocale(): string { return this.getLocale(); }
  getPreferredSystemLanguages(): string[] { return [this.getLocale()]; }
  setAppUserModelId(_id: string): void {}
  isInApplicationsFolder(): boolean { return appInfo().isInApplicationsFolder; }

  getPath(name: string): string {
    const set = this.paths.get(name);
    if (set) return set;
    const paths = appInfo();
    switch (name) {
      case "home": return paths.home;
      case "appData": return paths.appData;
      case "userData": return join(paths.appData, this.getName());
      case "sessionData": return this.getPath("userData");
      case "temp": return paths.temp;
      case "exe": return paths.exe;
      case "module": return paths.exe;
      case "desktop": return paths.desktop;
      case "documents": return paths.documents;
      case "downloads": return paths.downloads;
      case "music": return paths.music;
      case "pictures": return paths.pictures;
      case "videos": return paths.videos;
      case "logs": return join(paths.logs, this.getName());
      case "crashDumps": return join(this.getPath("userData"), "Crashpad");
      default: throw new Error(`Failed to get '${name}' path`);
    }
  }

  setPath(name: string, path: string): void { this.paths.set(name, path); }

  setActivationPolicy(policy: "regular" | "accessory" | "prohibited"): void { post("appSetActivationPolicy", policy); }
  focus(_options?: { steal?: boolean }): void { post("appFocus"); }
  hide(): void { post("appHide"); }
  show(): void { post("appFocus"); }

  requestSingleInstanceLock(): boolean { return ui<boolean>("appSingleInstanceLock", this.getPath("userData")); }
  hasSingleInstanceLock(): boolean { return true; }
  releaseSingleInstanceLock(): void {}

  getLoginItemSettings(): { openAtLogin: boolean; openAsHidden: boolean; wasOpenedAtLogin: boolean; wasOpenedAsHidden: boolean; restoreState: boolean; status: string } {
    return ui("loginItemGet");
  }
  setLoginItemSettings(settings: { openAtLogin?: boolean; openAsHidden?: boolean }): void { post("loginItemSet", settings); }

  relaunch(): void { throw new Error("app.relaunch is not available in the native host"); }

  quit(): void {
    if (this.quitting) return;
    const before = new ElectronEvent();
    this.emit("before-quit", before);
    if (before.defaultPrevented) return;
    this.quitting = true;
    for (const window of allWindows()) {
      window.close();
      if (!window.isDestroyed()) {
        this.quitting = false;
        return;
      }
    }
    const will = new ElectronEvent();
    this.emit("will-quit", will);
    if (will.defaultPrevented) {
      this.quitting = false;
      return;
    }
    this.emit("quit", new ElectronEvent(), 0);
    process.exit(0);
  }

  /** Called when the last window goes, as Electron does: with no listener the app quits. */
  windowsAllClosed(): void {
    if (this.quitting) return;
    if (this.listenerCount("window-all-closed") === 0) this.quit();
    else this.emit("window-all-closed");
  }

  exit(code = 0): void {
    this.quitting = true;
    process.exit(code);
  }
}

export const app = new App();
