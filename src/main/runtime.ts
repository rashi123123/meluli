import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { AppStateSnapshot, MainView, OverlaySession, RecordingHoldPhase } from "@shared/types";

import type { AppWindowRole } from "@shared/window-role";

/** Emitted on the runtime with the new snapshot after every state change. Not a renderer channel. */
export const RUNTIME_STATE_EVENT = "state";
/** Emitted on the runtime when a transcript is ready, so the tray can show it. Not a renderer channel. */
export const TRAY_READY_EVENT = "tray-ready";
export const RECORDING_BUSY_MESSAGE = "כבר יש הקלטה או עיבוד פעילים.";

type Status = AppStateSnapshot["status"];
/** Nothing is recording or being processed; an error left on screen does not hold anything up. */
export const isFree = (status: Status): boolean => status === "idle" || status === "error";
/** A microphone recording is open, running or paused. */
export const isRecording = (status: Status): boolean => status === "recording" || status === "paused";
/** A job is downloading or being transcribed. */
export const isWorking = (status: Status): boolean => status === "processing" || status === "youtube_downloading";
/** The user's own dictation is still in progress: recording, or the microphone audio is being transcribed. */
export const isDictating = (status: Status, source: AppStateSnapshot["activeSourceType"]): boolean =>
  isRecording(status) || (status === "processing" && source === "microphone");
/** Nothing runs and no dictation session is open, so the app the user is in may become the paste target. */
export const mayRetarget = (state: AppStateSnapshot): boolean => isFree(state.status) && !state.overlaySession;

/** A new job may start only when no window holds the microphone and nothing is recording or processing. */
export function assertNothingRunning(runtime: Pick<AppRuntime, "hasRecordingOwner" | "getState">): void {
  if (runtime.hasRecordingOwner() || !isFree(runtime.getState().status)) throw new Error(RECORDING_BUSY_MESSAGE);
}

export class AppRuntime extends EventEmitter {
  private state: AppStateSnapshot = {
    status: "idle",
    timerStartedAt: null,
    processingStartedAt: null,
    processingEstimateMs: null,
    processingProgressRatio: null,
    activeSourceType: null,
    currentYoutubeJob: null,
    pendingYoutubeJob: null,
    lastError: null,
    overlaySession: null,
    holdKey: { status: "off" },
    update: { status: "off", version: null }
  };

  private windows = new Map<AppWindowRole, BrowserWindow>();
  private overlayReady = false;
  private pendingRecordingToggle = false;
  private pendingHold = false;
  /** Audio the overlay keeps in memory. The audio itself never reaches this process. */
  private heldRecording: "failed" | "canceled" | null = null;
  private recordingOwner: number | null = null;
  private pasteRetry: { settled: Promise<void>; finish: () => void } | null = null;

  claimRecording(senderId: number): void {
    const { status } = this.state;
    if (status === "paused" && this.recordingOwner === senderId) return;
    if (this.recordingOwner !== null || !isFree(status)) {
      throw new Error(RECORDING_BUSY_MESSAGE);
    }
    this.recordingOwner = senderId;
  }

  /** Claims now, so nothing else starts during the wait, then checks that the window outlived it. */
  async claimRecordingAfter(senderId: number, wait: () => Promise<void>): Promise<void> {
    this.claimRecording(senderId);
    await wait();
    this.assertRecordingOwner(senderId);
  }

  /** A manual paste retry runs at status idle, so this is what keeps shortcuts out of it. */
  isPasteRetrying(): boolean {
    return this.pasteRetry !== null;
  }

  setPasteRetrying(retrying: boolean): void {
    this.pasteRetry?.finish();
    this.pasteRetry = null;
    if (!retrying) return;
    let finish = () => {};
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    this.pasteRetry = { settled, finish };
  }

  whenPasteRetrySettled(): Promise<void> {
    return this.pasteRetry?.settled ?? Promise.resolve();
  }

  assertRecordingOwner(senderId: number): void {
    if (this.recordingOwner !== senderId) throw new Error("אין הקלטה פעילה בחלון הזה.");
  }

  releaseRecording(senderId: number): void {
    this.assertRecordingOwner(senderId);
    this.recordingOwner = null;
  }

  isRecordingOwner(senderId: number): boolean {
    return this.recordingOwner === senderId;
  }

  hasRecordingOwner(): boolean {
    return this.recordingOwner !== null;
  }

  setOverlayReady(): void {
    this.overlayReady = true;
    if (this.pendingRecordingToggle) {
      this.pendingRecordingToggle = false;
      this.requestRecordingToggle();
    }
    if (this.pendingHold) {
      this.pendingHold = false;
      this.requestRecordingHold("press");
    }
  }

  cancelPendingRecordingToggle(): void {
    this.pendingRecordingToggle = false;
  }

  cancelPendingRecordingHold(): void {
    this.pendingHold = false;
  }

  setWindow(role: AppWindowRole, window: BrowserWindow): void {
    this.windows.set(role, window);
    if (role === "overlay") this.overlayReady = false;
    window.webContents.on?.("render-process-gone", () => {
      if (role === "overlay") {
        this.overlayReady = false;
        this.pendingRecordingToggle = false;
        this.pendingHold = false;
      }
      if (this.recordingOwner === window.webContents.id) {
        this.recordingOwner = null;
        this.clearOverlaySession();
        this.updateState({ status: "error", timerStartedAt: null, activeSourceType: null,
          lastError: "חלון ההקלטה נסגר באופן לא צפוי. אפשר להתחיל הקלטה חדשה." });
      }
    });

    window.on("closed", () => {
      if (this.windows.get(role) === window) {
        this.windows.delete(role);
      }
    });

    const sendCurrentState = () => {
      this.sendTo(role, IPC_CHANNELS.appState, this.state);
    };

    if (window.webContents.isLoadingMainFrame()) {
      window.webContents.once("did-finish-load", sendCurrentState);
    } else {
      sendCurrentState();
    }
  }

  releaseOverlayFocusForPaste(): () => void {
    const window = this.windows.get("overlay");
    if (!window || window.isDestroyed() || !window.isVisible()) return () => {};
    // A macOS nonactivating panel can own the key window while another app is
    // frontmost. Hiding it releases that keyboard focus before Cmd+V is sent.
    window.hide();
    return () => {
      if (this.windows.get("overlay") === window && !window.isDestroyed()) window.showInactive();
    };
  }

  getState(): AppStateSnapshot {
    return this.state;
  }

  getWindowRoleForWebContents(webContents: WebContents): AppWindowRole | null {
    for (const [role, window] of this.windows) {
      if (window.webContents === webContents) {
        return role;
      }
    }

    return null;
  }

  updateState(next: Partial<AppStateSnapshot>): AppStateSnapshot {
    const normalizedNext = { ...next };
    if ("status" in normalizedNext && normalizedNext.status !== "processing") {
      normalizedNext.processingStartedAt = null;
      normalizedNext.processingEstimateMs = null;
      normalizedNext.processingProgressRatio = null;
    }

    this.state = {
      ...this.state,
      ...normalizedNext
    };
    this.commitState();
    return this.state;
  }

  /** A background job reports here, so it cannot write over a recording that holds the claim. */
  updateJobState(next: Partial<AppStateSnapshot>): AppStateSnapshot {
    return this.hasRecordingOwner() ? this.state : this.updateState(next);
  }

  startOverlaySession(targetAppName: string | null): OverlaySession {
    const overlaySession: OverlaySession = {
      id: crypto.randomUUID(),
      phase: "recording",
      transcriptId: null,
      transcriptText: null,
      targetAppName,
      lastErrorCode: null
    };
    this.state = {
      ...this.state,
      overlaySession
    };
    this.commitState();
    return overlaySession;
  }

  updateOverlaySession(next: Partial<OverlaySession>): OverlaySession | null {
    if (!this.state.overlaySession) {
      return null;
    }

    this.state = {
      ...this.state,
      overlaySession: {
        ...this.state.overlaySession,
        ...next
      }
    };
    this.commitState();
    return this.state.overlaySession ?? null;
  }

  clearOverlaySession(): void {
    if (!this.state.overlaySession) {
      return;
    }

    this.state = {
      ...this.state,
      overlaySession: null
    };
    this.commitState();
  }

  signalTrayReady(): void {
    this.emit(TRAY_READY_EVENT);
  }

  private commitState(): void {
    this.emit(RUNTIME_STATE_EVENT, this.state);
    this.send(IPC_CHANNELS.appState, this.state);
  }

  requestRecordingToggle(): void {
    if (!this.overlayReady) {
      this.pendingRecordingToggle = true;
      return;
    }
    this.sendTo("overlay", IPC_CHANNELS.recordingToggleRequested, null);
  }

  /** Returns whether the overlay hears it. A release it will not hear means it never saw the press. */
  requestRecordingHold(phase: RecordingHoldPhase): boolean {
    if (!this.overlayReady || (phase === "release" && this.pendingHold)) {
      this.pendingHold = phase === "press";
      return false;
    }
    this.sendTo("overlay", IPC_CHANNELS.recordingHoldRequested, phase);
    return true;
  }

  requestRecordingCancel(): void {
    this.sendTo("overlay", IPC_CHANNELS.recordingCancelRequested, null);
  }

  getHeldRecording() { return this.heldRecording; }

  setHeldRecording(reason: "failed" | "canceled" | null): void {
    this.heldRecording = reason;
    this.emit(RUNTIME_STATE_EVENT, this.state);
  }

  requestRecordingUndo(): void {
    this.sendTo("overlay", IPC_CHANNELS.recordingUndoRequested, null);
  }

  /** Stops capture but keeps the audio, for an end the user did not choose such as sleep. */
  requestRecordingInterrupt(): void {
    for (const [role, window] of this.windows) {
      if (window.webContents.id === this.recordingOwner) this.sendTo(role, IPC_CHANNELS.recordingInterruptRequested, null);
    }
  }

  requestMainNavigation(view: MainView): void {
    this.sendTo("main", IPC_CHANNELS.appNavigateRequested, view);
  }

  send(channel: string, payload: unknown): void {
    for (const [role] of this.windows) {
      this.sendTo(role, channel, payload);
    }
  }

  sendTo(role: AppWindowRole, channel: string, payload: unknown): void {
    const window = this.windows.get(role);
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }

    const deliver = () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        return;
      }

      window.webContents.send(channel, payload);
    };

    if (window.webContents.isLoadingMainFrame()) {
      window.webContents.once("did-finish-load", deliver);
      return;
    }

    deliver();
  }
}
