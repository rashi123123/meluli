import type { BrowserWindow, Rectangle } from "electron";
import type { MainView } from "@shared/types";

/**
 * Owns the main window's lifetime. A hidden main window still costs a renderer process, so after
 * it has stayed hidden for `releaseDelayMs` it is destroyed and recreated on the next show. It is
 * kept while it owns something a new renderer could not rebuild: an active recording, a running
 * job it shows, or an edit the renderer reports as unsaved.
 *
 * Only a hide that goes through `hide()` counts. Electron also emits `hide` when a window is
 * minimized or covered by other windows, and those must never release it.
 */
export interface MainWindowHostOptions {
  create(view: MainView | null): BrowserWindow;
  /** Registers a new window with the runtime and anything else that tracks windows. */
  attach(window: BrowserWindow): void;
  /** Main-process reasons to keep the window, such as the recording owner. */
  mustKeep(window: BrowserWindow): boolean;
  /** Sends a view to a live window. */
  navigate(view: MainView): void;
  isQuitting(): boolean;
  releaseDelayMs: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class MainWindowHost {
  private window: BrowserWindow | null = null;
  private rendererKeeps = false;
  private lastView: MainView | null = null;
  private bounds: Rectangle | null = null;
  private timer: unknown = null;
  private released = 0;
  private hiddenByHost = false;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: MainWindowHostOptions) {
    this.setTimer = options.setTimer ?? ((run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** The live window, or null while it is released. */
  get current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  get releaseCount(): number {
    return this.released;
  }

  /** Creates the window if needed and returns it, without showing it. */
  ensure(view: MainView | null = null): BrowserWindow {
    const live = this.current;
    if (live) {
      if (view) this.options.navigate(view);
      return live;
    }
    const window = this.options.create(view ?? this.lastView);
    this.window = window;
    this.rendererKeeps = false;
    this.hiddenByHost = false;
    if (this.bounds) window.setBounds(this.bounds);
    window.on("show", () => { this.hiddenByHost = false; this.cancel(); });
    window.on("closed", () => {
      this.cancel();
      if (this.window === window) this.window = null;
    });
    this.options.attach(window);
    return window;
  }

  show(view: MainView | null = null): BrowserWindow | null {
    if (this.options.isQuitting()) return null;
    this.hiddenByHost = false;
    this.cancel();
    const window = this.ensure(view);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  /** Hides the window, which starts the release delay. */
  hide(): void {
    const live = this.current;
    if (!live) return;
    live.hide();
    this.hiddenByHost = true;
    this.schedule();
  }

  toggle(): void {
    if (this.current?.isVisible()) {
      this.hide();
      return;
    }
    this.show();
  }

  /** What the main renderer reports about itself. Ignored from any other sender. */
  report(sender: unknown, state: { view: MainView; keep: boolean }): void {
    const live = this.current;
    if (!live || live.webContents !== sender) return;
    this.lastView = state.view;
    const wasKept = this.rendererKeeps;
    this.rendererKeeps = state.keep;
    if (wasKept && !state.keep && this.hiddenByHost) this.schedule();
  }

  /** Destroys the hidden window now if nothing needs it. Returns whether it was released. */
  releaseIfIdle(): boolean {
    this.cancel();
    const live = this.current;
    if (!live || this.options.isQuitting() || !this.hiddenByHost || live.isVisible()) return false;
    if (this.rendererKeeps || this.options.mustKeep(live)) {
      this.schedule();
      return false;
    }
    this.bounds = live.getBounds();
    this.window = null;
    this.released++;
    live.destroy();
    return true;
  }

  dispose(): void {
    this.cancel();
  }

  private schedule(): void {
    this.cancel();
    if (this.options.releaseDelayMs < 0) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.releaseIfIdle();
    }, this.options.releaseDelayMs);
  }

  private cancel(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
