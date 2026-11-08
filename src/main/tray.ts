import { app, Menu, Tray, nativeImage, systemPreferences } from "electron";
import { join } from "node:path";
import { resourcesRoot } from "./config/paths";
import type { AppStateSnapshot, MainView } from "@shared/types";
import { he } from "@shared/locale";
import { AppRuntime, isRecording, isWorking, RUNTIME_STATE_EVENT, TRAY_READY_EVENT } from "./runtime";
import { buildTrayPresentation, type TrayVisualState } from "./tray-presentation";

const READY_VISIBLE_MS = 10_000;
const WAVE_FRAME_COUNT = 6;
const WAVE_FRAME_MS = 130;
const waveFile = (frame: number) => `tray-processing${frame}Template.png`;
const TRAY_ICON_FILES: Record<TrayVisualState, string> = {
  idle: "tray-idleTemplate.png",
  recording: "tray-idleTemplate.png",
  paused: "tray-pausedTemplate.png",
  processing: waveFile(0),
  ready: "tray-readyTemplate.png"
};
const STATUS_SYMBOLS: Record<TrayVisualState, string> = {
  idle: "mic",
  recording: "mic.fill",
  paused: "pause.circle",
  processing: "waveform",
  ready: "checkmark.circle"
};
const iconCache = new Map<string, ReturnType<typeof nativeImage.createEmpty>>();
function resolveTrayIconPath(fileName: string): string {
  return join(resourcesRoot(app), "icons", fileName);
}

function resolveIcon(fileName: string): ReturnType<typeof nativeImage.createEmpty> {
  const cached = iconCache.get(fileName);
  if (cached) {
    return cached;
  }

  const icon = nativeImage.createFromPath(resolveTrayIconPath(fileName));
  icon.setTemplateImage(true);
  iconCache.set(fileName, icon);
  return icon;
}

/** What the menu's first item does in this state. */
function recordingIntent(snapshot: AppStateSnapshot): "stop" | "cancel" | "start" {
  return isRecording(snapshot.status) ? "stop" : isWorking(snapshot.status) ? "cancel" : "start";
}

export class TrayManager {
  private tray: Tray | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;
  private waveInterval: NodeJS.Timeout | null = null;
  private readyUntilMs: number | null = null;
  private lastContextMenuKey: string | null = null;
  private lastIconState: TrayVisualState | null = null;
  private lastTitle = "";

  constructor(
    private readonly runtime: AppRuntime,
    private readonly handlers: {
      onToggleWindow: () => void;
      onOpenView: (view: MainView) => void;
      onToggleRecording: () => void;
      onStopCall: () => void;
      onQuit: () => void;
    }
  ) {}

  init(): void {
    const initialPresentation = this.getPresentation(this.runtime.getState());
    this.tray = new Tray(resolveIcon(TRAY_ICON_FILES[initialPresentation.iconState]));
    this.tray.setToolTip(he.appName);
    this.tray.setTitle(process.platform === "darwin" ? initialPresentation.title : "");
    this.tray.on("click", () => {
      this.handlers.onToggleWindow();
    });

    this.runtime.on(RUNTIME_STATE_EVENT, (snapshot: AppStateSnapshot) => {
      this.render(snapshot);
    });
    this.runtime.on(TRAY_READY_EVENT, () => {
      // The floating window reports its own result and can close before this window ends.
      if (this.runtime.getState().overlaySession) {
        return;
      }
      this.readyUntilMs = Date.now() + READY_VISIBLE_MS;
      this.render(this.runtime.getState());
    });

    this.render(this.runtime.getState());
  }

  private getPresentation(snapshot: AppStateSnapshot) {
    if (snapshot.status !== "idle") {
      this.readyUntilMs = null;
    } else if (this.readyUntilMs !== null && this.readyUntilMs <= Date.now()) {
      this.readyUntilMs = null;
    }

    return buildTrayPresentation({
      snapshot,
      now: Date.now(),
      readyUntilMs: this.readyUntilMs
    });
  }

  private render(snapshot: AppStateSnapshot): void {
    if (!this.tray) {
      return;
    }

    const presentation = this.getPresentation(snapshot);
    if (presentation.iconState !== this.lastIconState) {
      this.tray.setImage(resolveIcon(TRAY_ICON_FILES[presentation.iconState]));
      this.lastIconState = presentation.iconState;
    }
    this.manageWaves(presentation.iconState === "processing");
    if (process.platform === "darwin" && presentation.title !== this.lastTitle) {
      // Fixed digit widths keep the menu bar from shifting on every tick.
      this.tray.setTitle(presentation.title, { fontType: "monospacedDigit" });
      this.lastTitle = presentation.title;
    }

    const intent = recordingIntent(snapshot);
    const recordingAction =
      isRecording(snapshot.status)
        ? { label: he.trayStopAndTranscribe, symbol: "stop.circle" }
        : isWorking(snapshot.status)
          ? { label: he.trayCancelProcessing, symbol: "xmark.circle" }
          : { label: he.trayStartRecording, symbol: "record.circle" };
    const contextMenuKey = [
      presentation.iconState,
      presentation.menuLabel,
      recordingAction.label,
      snapshot.call?.recording ? "call" : "",
      snapshot.status,
      snapshot.activeSourceType ?? "",
      snapshot.currentYoutubeJob?.url ?? "",
      snapshot.currentYoutubeJob?.title ?? "",
      snapshot.pendingYoutubeJob?.url ?? ""
    ].join("|");

    if (contextMenuKey !== this.lastContextMenuKey) {
      const contextMenu = Menu.buildFromTemplate([
        {
          label: `${he.appName} · ${presentation.menuLabel}`,
          icon: nativeImage.createMenuSymbol(STATUS_SYMBOLS[presentation.iconState]),
          enabled: false
        },
        { type: "separator" },
        {
          label: recordingAction.label,
          icon: nativeImage.createMenuSymbol(recordingAction.symbol),
          // A menu that was open while the state moved on does only what its label said, or nothing.
          click: () => {
            if (recordingIntent(this.runtime.getState()) === intent) this.handlers.onToggleRecording();
          }
        },
        ...(snapshot.call?.recording ? [{
          label: he.callStop,
          icon: nativeImage.createMenuSymbol("stop.circle"),
          click: this.handlers.onStopCall
        }] : []),
        { type: "separator" },
        {
          label: he.workspace,
          icon: nativeImage.createMenuSymbol("house"),
          click: () => this.handlers.onOpenView("workspace")
        },
        {
          label: he.history,
          icon: nativeImage.createMenuSymbol("clock"),
          click: () => this.handlers.onOpenView("history")
        },
        {
          label: he.dictionaryTitle,
          icon: nativeImage.createMenuSymbol("book.closed"),
          click: () => this.handlers.onOpenView("dictionary")
        },
        {
          label: he.settings,
          icon: nativeImage.createMenuSymbol("gearshape"),
          click: () => this.handlers.onOpenView("settings")
        },
        { type: "separator" },
        {
          label: he.quit,
          icon: nativeImage.createMenuSymbol("power"),
          click: this.handlers.onQuit
        }
      ]);

      this.tray.setContextMenu(contextMenu);
      this.lastContextMenuKey = contextMenuKey;
    }
    this.manageRefresh(presentation.shouldRefresh);
  }

  private manageWaves(active: boolean): void {
    if (!active) {
      if (this.waveInterval) {
        clearInterval(this.waveInterval);
        this.waveInterval = null;
      }
      return;
    }

    if (this.waveInterval || systemPreferences.getAnimationSettings().prefersReducedMotion) {
      return;
    }
    let frame = 0;
    this.waveInterval = setInterval(() => {
      frame = (frame + 1) % WAVE_FRAME_COUNT;
      this.tray?.setImage(resolveIcon(waveFile(frame)));
    }, WAVE_FRAME_MS);
  }

  private manageRefresh(shouldRefresh: boolean): void {
    if (shouldRefresh) {
      if (!this.refreshInterval) {
        this.refreshInterval = setInterval(() => {
          this.render(this.runtime.getState());
        }, 1000);
      }
      return;
    }

    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}
