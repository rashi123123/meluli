/* @vitest-environment node */

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { AppRuntime } from "@main/runtime";

function createWindowMock() {
  const listeners = new Map<string, Array<() => void>>();
  const send = vi.fn();

  return {
    window: {
      on: (event: string, listener: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        isLoadingMainFrame: () => false,
        once: vi.fn(),
        send
      }
    },
    send
  };
}

describe("AppRuntime", () => {
  it("broadcasts state updates to both registered windows", () => {
    const runtime = new AppRuntime();
    const main = createWindowMock();
    const overlay = createWindowMock();

    runtime.setWindow("main", main.window as never);
    runtime.setWindow("overlay", overlay.window as never);
    runtime.updateState({
      status: "recording",
      timerStartedAt: 123,
      activeSourceType: "microphone"
    });

    expect(main.send).toHaveBeenCalledWith(
      IPC_CHANNELS.appState,
      expect.objectContaining({
        status: "recording",
        activeSourceType: "microphone"
      })
    );
    expect(overlay.send).toHaveBeenCalledWith(
      IPC_CHANNELS.appState,
      expect.objectContaining({
        status: "recording",
        activeSourceType: "microphone"
      })
    );
  });

  it("sends shortcut toggle requests only to the overlay window", () => {
    const runtime = new AppRuntime();
    const main = createWindowMock();
    const overlay = createWindowMock();

    runtime.setWindow("main", main.window as never);
    runtime.setWindow("overlay", overlay.window as never);
    runtime.setOverlayReady();
    runtime.requestRecordingToggle();

    expect(overlay.send).toHaveBeenCalledWith(IPC_CHANNELS.recordingToggleRequested, null);
    expect(main.send).not.toHaveBeenCalledWith(IPC_CHANNELS.recordingToggleRequested, null);
  });

  it("tracks additive overlay session state without changing the existing runtime channels", () => {
    const runtime = new AppRuntime();
    const overlay = createWindowMock();

    runtime.setWindow("overlay", overlay.window as never);

    const started = runtime.startOverlaySession("Safari");
    runtime.updateOverlaySession({
      phase: "paste_failed",
      transcriptId: "tx-1",
      transcriptText: "שלום",
      lastErrorCode: "target_unavailable"
    });

    expect(started.targetAppName).toBe("Safari");
    expect(runtime.getState().overlaySession).toEqual({
      id: started.id,
      phase: "paste_failed",
      transcriptId: "tx-1",
      transcriptText: "שלום",
      targetAppName: "Safari",
      lastErrorCode: "target_unavailable"
    });

    runtime.clearOverlaySession();

    expect(runtime.getState().overlaySession).toBeNull();
    expect(overlay.send).toHaveBeenCalledWith(
      IPC_CHANNELS.appState,
      expect.objectContaining({
        overlaySession: null
      })
    );
  });

  it("emits an internal tray-ready signal without changing renderer channels", () => {
    const runtime = new AppRuntime();
    const listener = vi.fn();

    runtime.on("tray-ready", listener);
    runtime.signalTrayReady();

    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("queues only one shortcut until the overlay has subscribed and loaded settings", () => {
    const runtime = new AppRuntime();
    const overlay = createWindowMock();
    runtime.setWindow("overlay", overlay.window as never);
    overlay.send.mockClear();
    runtime.requestRecordingToggle();
    runtime.requestRecordingToggle();
    expect(overlay.send).not.toHaveBeenCalled();
    runtime.setOverlayReady();
    runtime.setOverlayReady();
    expect(overlay.send).toHaveBeenCalledTimes(1);
    expect(overlay.send).toHaveBeenCalledWith(IPC_CHANNELS.recordingToggleRequested, null);
  });

  it("allows a pending startup shortcut to be dismissed without opening a microphone", () => {
    const runtime = new AppRuntime();
    const overlay = createWindowMock();
    runtime.setWindow("overlay", overlay.window as never);
    overlay.send.mockClear();
    runtime.requestRecordingToggle();
    runtime.cancelPendingRecordingToggle();
    runtime.setOverlayReady();
    expect(overlay.send).not.toHaveBeenCalled();
  });

  it("releases the panel key window for paste and restores feedback without activation", () => {
    const runtime = new AppRuntime();
    const overlay = createWindowMock();
    const hide = vi.fn();
    const showInactive = vi.fn();
    let destroyed = false;
    Object.assign(overlay.window, { isVisible: () => true, hide, showInactive, isDestroyed: () => destroyed });
    runtime.setWindow("overlay", overlay.window as never);
    const restore = runtime.releaseOverlayFocusForPaste();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(showInactive).not.toHaveBeenCalled();
    restore();
    expect(showInactive).toHaveBeenCalledTimes(1);
    const restoreAfterClosing = runtime.releaseOverlayFocusForPaste();
    destroyed = true;
    restoreAfterClosing();
    expect(showInactive).toHaveBeenCalledTimes(1);
  });

  it("reserves microphone ownership synchronously across both windows", () => {
    const runtime = new AppRuntime();
    runtime.claimRecording(1);
    expect(() => runtime.claimRecording(2)).toThrow();
    expect(() => runtime.releaseRecording(2)).toThrow();
    runtime.updateState({ status: "paused" });
    expect(() => runtime.claimRecording(1)).not.toThrow();
    runtime.releaseRecording(1);
    runtime.updateState({ status: "processing" });
    expect(() => runtime.claimRecording(1)).toThrow();
    runtime.updateState({ status: "idle" });
    expect(() => runtime.claimRecording(2)).not.toThrow();
  });

  it("gives every state listener a snapshot when held audio changes", () => {
    const runtime = new AppRuntime();
    const listener = vi.fn();
    runtime.on("state", listener);
    runtime.setHeldRecording("canceled");
    expect(listener).toHaveBeenCalledWith(runtime.getState());
    expect(runtime.getHeldRecording()).toBe("canceled");
  });
});
