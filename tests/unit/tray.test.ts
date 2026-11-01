/* @vitest-environment node */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trayMock = vi.hoisted(() => ({
  setImage: vi.fn(),
  setTitle: vi.fn(),
  setContextMenu: vi.fn(),
  animationSettings: vi.fn(() => ({ prefersReducedMotion: false }))
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  nativeImage: {
    createEmpty: vi.fn(),
    createFromPath: vi.fn((path: string) => ({ path, setTemplateImage: vi.fn() })),
    createMenuSymbol: vi.fn((symbol: string) => ({ symbol }))
  },
  systemPreferences: { getAnimationSettings: trayMock.animationSettings },
  Tray: class {
    setImage = trayMock.setImage;
    setTitle = trayMock.setTitle;
    setToolTip = vi.fn();
    setContextMenu = trayMock.setContextMenu;
    on = vi.fn();
  }
}));

import { TrayManager } from "@main/tray";
import type { AppRuntime } from "@main/runtime";
import { he } from "@shared/locale";
import type { AppStateSnapshot } from "@shared/types";

const idle: AppStateSnapshot = {
  status: "idle",
  timerStartedAt: null,
  processingStartedAt: null,
  processingEstimateMs: null,
  processingProgressRatio: null,
  lastError: null,
  overlaySession: null
};
const finishedOverlay: AppStateSnapshot = {
  ...idle,
  overlaySession: {
    id: "overlay",
    phase: "success",
    transcriptId: null,
    transcriptText: null,
    targetAppName: null,
    lastErrorCode: null
  }
};

class FakeRuntime extends EventEmitter {
  state = idle;
  getState() {
    return this.state;
  }
  publish(state: AppStateSnapshot) {
    this.state = state;
    this.emit("state", state);
  }
}

const startTray = () => {
  const runtime = new FakeRuntime();
  new TrayManager(runtime as unknown as AppRuntime, {
    onToggleWindow: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onOpenHistory: vi.fn(),
    onOpenDictionary: vi.fn(),
    onStopCall: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleRecording: vi.fn(),
    onQuit: vi.fn()
  }).init();
  return runtime;
};
const shownIcons = () => trayMock.setImage.mock.calls.map(([icon]) => (icon as { path: string }).path);

describe("TrayManager", () => {
  beforeEach(() => {
    trayMock.setImage.mockReset();
    trayMock.setTitle.mockReset();
    trayMock.animationSettings.mockReturnValue({ prefersReducedMotion: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the ready mark after a main-window transcription", () => {
    const runtime = startTray();
    runtime.emit("tray-ready");
    expect(shownIcons().at(-1)).toContain("tray-readyTemplate");
  });

  it("stays at rest when the floating window closes right after its result", () => {
    const runtime = startTray();
    runtime.publish(finishedOverlay);
    runtime.emit("tray-ready");
    runtime.publish(idle);
    expect(shownIcons().some((path) => path.includes("tray-readyTemplate"))).toBe(false);
  });

  it("keeps the resting mark while recording", () => {
    const runtime = startTray();
    runtime.publish({ ...idle, status: "recording", timerStartedAt: Date.now(), activeSourceType: "microphone" });
    expect(shownIcons().at(-1)).toContain("tray-idleTemplate");
  });

  it("moves the sound waves during transcription and stops afterwards", () => {
    vi.useFakeTimers();
    const runtime = startTray();
    runtime.publish({ ...idle, status: "processing" });
    vi.advanceTimersByTime(400);
    expect(shownIcons().slice(-3).map((path) => path.split("/").pop())).toEqual(["tray-processing1Template.png", "tray-processing2Template.png", "tray-processing3Template.png"]);

    runtime.publish(idle);
    const shown = shownIcons().length;
    vi.advanceTimersByTime(1000);
    expect(shownIcons()).toHaveLength(shown);
    expect(shownIcons().at(-1)).toContain("tray-idleTemplate");
  });

  it("holds the sound waves still when the system reduces motion", () => {
    vi.useFakeTimers();
    trayMock.animationSettings.mockReturnValue({ prefersReducedMotion: true });
    const runtime = startTray();
    runtime.publish({ ...idle, status: "processing" });
    const shown = shownIcons().length;
    vi.advanceTimersByTime(1000);
    expect(shownIcons()).toHaveLength(shown);
  });

  it("opens the dictionary from the menu", () => {
    const runtime = startTray();
    runtime.publish({ ...idle, status: "processing" });
    const items = trayMock.setContextMenu.mock.lastCall![0] as Array<{ label?: string }>;
    expect(items.map((item) => item.label)).toContain(he.dictionaryTitle);
  });

  it("keeps the timer digits at a fixed width", () => {
    const runtime = startTray();
    runtime.publish({ ...idle, status: "recording", timerStartedAt: Date.now() - 3_000, activeSourceType: "microphone" });
    expect(trayMock.setTitle).toHaveBeenLastCalledWith("00:03", { fontType: "monospacedDigit" });
  });
});
