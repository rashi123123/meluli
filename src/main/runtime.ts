import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { AppStateSnapshot, MainView, OverlaySession, RecordingHoldPhase } from "@shared/types";

export type AppWindowRole = "main" | "overlay" | "call";
const TRAY_READY_EVENT = "tray-ready";

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

  claimRecording(senderId: number): void {
    const { status } = this.state;
    if (status === "paused" && this.recordingOwner === senderId) return;
    if (this.recordingOwner !== null || (status !== "idle" && status !== "error")) {
      throw new Error("כבר יש הקלטה או עיבוד פעילים.");
    }
    this.recordingOwner = senderId;
  }

  assertRecordingOwner(senderId: number): void {
    if (this.recordingOwner !== senderId) throw new Error("אין הקלטה פעילה בחלון הזה.");
  }

  releaseRecording(senderId: number): void {
    this.assertRecordingOwner(senderId);
    this.recordingOwner = null;
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
    this.emit("state", this.state);
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
    this.emit("state", this.state);
  }

  requestRecordingUndo(): void {
    this.sendTo("overlay", IPC_CHANNELS.recordingUndoRequested, null);
  }

  /** Stops capture but keeps the audio, for an end the user did not choose such as sleep. */
  requestRecordingInterrupt(): void {
    this.sendTo("overlay", IPC_CHANNELS.recordingInterruptRequested, null);
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
