import { pipelineTrace } from "./pipeline-trace";
import type { AppRuntime } from "./runtime";
import type { TextInsertionService } from "./services/text-insertion.service";

/** Owns shortcut ordering; the renderer owns microphone capture. */
export class OverlayController {
  private opening = false;
  private keyHeld = false;
  private retryHold = false;
  private closeWhenOpened = false;
  /** Null unless a toggle press is waiting behind a paste retry. */
  private toggleWanted: boolean | null = null;

  constructor(private readonly dependencies: {
    runtime: AppRuntime;
    textInsertion: () => TextInsertionService;
    show: (activate: boolean) => void;
    hide: () => void;
  }) {}

  async open(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      await this.captureTargetWhenIdle();
      this.dependencies.show(true);
    } finally {
      this.opening = false;
      this.settleHold();
    }
  }

  /** Points a recording sent again at wherever the user is now. The window is already up. */
  async retarget(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      const state = this.dependencies.runtime.getState();
      if (this.dependencies.runtime.isPasteRetrying()) return;
      if (state.overlaySession && (state.status === "idle" || state.status === "error")) {
        this.dependencies.runtime.clearOverlaySession();
      }
      await this.captureTargetWhenIdle();
    } finally {
      this.opening = false;
      this.settleHold();
    }
  }

  async toggleRecording(): Promise<void> {
    if (this.opening) {
      // Behind a running retry each press flips the waiting one, so the last press decides.
      if (this.toggleWanted !== null) this.toggleWanted = !this.toggleWanted;
      return;
    }
    this.opening = true;
    try {
      if (this.dependencies.runtime.isPasteRetrying()) {
        this.toggleWanted = true;
        const clear = await this.waitForPasteRetry();
        const wanted = this.toggleWanted;
        this.toggleWanted = null;
        if (!clear || !wanted) return;
      }
      const state = this.dependencies.runtime.getState();
      if (state.status === "processing" || state.status === "youtube_downloading") {
        if (state.activeSourceType === "microphone") this.dependencies.show(false);
        return;
      }
      if (state.overlaySession && (state.status === "idle" || state.status === "error")) {
        this.dependencies.runtime.clearOverlaySession();
      }
      // An inactive window leaves the target frontmost, so feedback needn't wait for the
      // capture. recording:start waits for it before the session reads the target.
      pipelineTrace("shortcut", "event");
      const capture = this.captureTargetWhenIdle();
      this.dependencies.show(false);
      this.dependencies.runtime.requestRecordingToggle();
      await capture;
    } finally {
      this.opening = false;
      this.settleHold();
    }
  }

  async beginHold(): Promise<void> {
    this.keyHeld = true;
    if (this.opening) {
      this.retryHold = true;
      return;
    }
    this.opening = true;
    try {
      if (this.dependencies.runtime.isPasteRetrying()) {
        const clear = await this.waitForPasteRetry();
        if (!this.keyHeld) {
          // The key came back during the wait, so nothing was asked of the result on screen.
          this.closeWhenOpened = false;
          return;
        }
        if (!clear) {
          // The press is spent, so its release must not close what it stopped for.
          this.keyHeld = false;
          return;
        }
      }
      const state = this.dependencies.runtime.getState();
      if (state.status === "recording" || state.status === "paused") return;
      if (state.status === "processing" || state.status === "youtube_downloading") {
        if (state.activeSourceType === "microphone") this.dependencies.show(false);
        return;
      }
      if (state.overlaySession && (state.status === "idle" || state.status === "error")) {
        this.dependencies.runtime.clearOverlaySession();
      }
      pipelineTrace("shortcut", "event");
      const capture = this.captureTargetWhenIdle();
      this.dependencies.show(false);
      this.dependencies.runtime.requestRecordingHold("press");
      await capture;
    } finally {
      this.opening = false;
      this.settleHold();
    }
  }

  endHold(): void {
    if (!this.keyHeld) return;
    this.keyHeld = false;
    this.retryHold = false;
    if (this.dependencies.runtime.requestRecordingHold("release")) return;
    // The overlay never saw the press, so nothing there will close the window it opened for.
    if (this.opening) this.closeWhenOpened = true;
    else this.hide();
  }

  /** Anything a hold asked for while the lock was taken runs here, once it is free. */
  private settleHold(): void {
    const retry = this.retryHold && this.keyHeld;
    const close = this.closeWhenOpened;
    this.retryHold = false;
    this.closeWhenOpened = false;
    if (retry) void this.beginHold();
    else if (close) this.hide();
  }

  hide(): boolean {
    const state = this.dependencies.runtime.getState();
    // Never strand an open microphone or discard a pending automatic paste. A shortcut
    // mid-flight counts: a closing success timer must not clear the target it just took.
    if (this.opening || state.status === "recording" || state.status === "paused" ||
        state.overlaySession?.phase === "processing" || this.dependencies.runtime.isPasteRetrying()) return false;
    this.dependencies.runtime.cancelPendingRecordingToggle();
    this.dependencies.runtime.cancelPendingRecordingHold();
    this.dependencies.runtime.clearOverlaySession();
    this.dependencies.textInsertion().clearTargetApplication();
    this.dependencies.hide();
    return true;
  }

  /**
   * A press keeps its place behind a running retry, whose result still belongs to the session on
   * screen. False means the result must stay up: an unknown outcome asks the user to look at the target.
   */
  private async waitForPasteRetry(): Promise<boolean> {
    this.dependencies.show(false);
    await this.dependencies.runtime.whenPasteRetrySettled();
    return this.dependencies.runtime.getState().overlaySession?.insertionOutcome !== "unknown";
  }

  private async captureTargetWhenIdle(): Promise<void> {
    const state = this.dependencies.runtime.getState();
    if ((state.status === "idle" || state.status === "error") && !state.overlaySession && !this.dependencies.runtime.isPasteRetrying()) {
      // Must precede show/focus, otherwise the captured target is Meluli itself.
      await this.dependencies.textInsertion().captureCurrentTargetApplication();
    }
  }
}
