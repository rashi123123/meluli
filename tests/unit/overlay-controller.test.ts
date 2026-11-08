/* @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { OverlayController } from "@main/overlay-controller";
import { AppRuntime } from "@main/runtime";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { clampOverlayPosition } from "@main/overlay-position";

function fixture() {
  const runtime = new AppRuntime();
  const calls: string[] = [];
  const insertion = {
    captureCurrentTargetApplication: vi.fn(async () => { calls.push("capture"); return { name: "TextEdit" }; }),
    clearTargetApplication: vi.fn()
  };
  const show = vi.fn((activate: boolean) => { calls.push(activate ? "focus" : "show-inactive"); });
  const hide = vi.fn();
  const toggle = vi.spyOn(runtime, "requestRecordingToggle");
  const controller = new OverlayController({ runtime, textInsertion: () => insertion as never, show, hide });
  return { runtime, calls, insertion, show, hide, toggle, controller };
}

describe("floating recorder control", () => {
  it("shows the window without focus and takes the target before a hold is heard", async () => {
    const f = fixture();
    f.runtime.setOverlayReady();
    const send = vi.spyOn(f.runtime, "sendTo");
    await f.controller.beginHold();
    expect(f.calls).toEqual(["capture", "show-inactive"]);
    expect(send).toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "press");
  });
  it("closes the window when the key comes back before the overlay has loaded", async () => {
    const f = fixture();
    await f.controller.beginHold();
    f.controller.endHold();
    expect(f.hide).toHaveBeenCalled();
    f.runtime.setOverlayReady();
    const send = vi.spyOn(f.runtime, "sendTo");
    f.runtime.setOverlayReady();
    expect(send).not.toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "press");
  });
  it("takes a press that lands while a target is being captured once the capture ends", async () => {
    const f = fixture();
    f.runtime.setOverlayReady();
    const send = vi.spyOn(f.runtime, "sendTo");
    let finish = () => {};
    f.insertion.captureCurrentTargetApplication.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ name: "TextEdit" });
    }));
    const first = f.controller.open();
    const held = f.controller.beginHold();
    await held;
    expect(send).not.toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "press");
    finish(); await first;
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "press"));
  });
  it("sends no press for a key that came back during the capture", async () => {
    const f = fixture();
    f.runtime.setOverlayReady();
    const send = vi.spyOn(f.runtime, "sendTo");
    let finish = () => {};
    f.insertion.captureCurrentTargetApplication.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ name: "TextEdit" });
    }));
    const first = f.controller.open();
    await f.controller.beginHold();
    f.controller.endHold();
    finish(); await first;
    expect(send).not.toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "press");
  });
  it("refuses to hide while a shortcut is taking its target, so a closing timer cannot clear it", async () => {
    const f = fixture();
    let finish = () => {};
    f.insertion.captureCurrentTargetApplication.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ name: "TextEdit" });
    }));
    const toggling = f.controller.toggleRecording();
    expect(f.controller.hide()).toBe(false);
    expect(f.insertion.clearTargetApplication).not.toHaveBeenCalled();
    finish(); await toggling;
    expect(f.controller.hide()).toBe(true);
  });
  it("captures the target before focusing and opens without starting a recording", async () => {
    const f = fixture();
    await f.controller.open();
    expect(f.calls).toEqual(["capture", "focus"]);
    expect(f.toggle).not.toHaveBeenCalled();
    expect(f.runtime.getState().overlaySession).toBeNull();
  });
  it("shows the recorder without stealing focus before delivering a recording shortcut", async () => {
    const f = fixture();
    await f.controller.toggleRecording();
    expect(f.calls).toEqual(["capture", "show-inactive"]);
    expect(f.toggle).toHaveBeenCalledTimes(1);
  });
  it("gives feedback without waiting for a slow target capture", async () => {
    const f = fixture();
    let finish!: () => void;
    f.insertion.captureCurrentTargetApplication.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ name: "TextEdit" });
    }));
    const pending = f.controller.toggleRecording();
    await Promise.resolve();
    expect(f.show).toHaveBeenCalledWith(false);
    expect(f.toggle).toHaveBeenCalledTimes(1);
    finish();
    await pending;
  });
  it("retargets a resent recording without moving focus or starting anything", async () => {
    const f = fixture();
    await f.controller.retarget();
    expect(f.calls).toEqual(["capture"]);
    expect(f.toggle).not.toHaveBeenCalled();
  });
  it("coalesces overlapping shortcuts while target capture is pending", async () => {
    const f = fixture();
    let finish!: () => void;
    f.insertion.captureCurrentTargetApplication.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ name: "TextEdit" });
    }));
    const first = f.controller.toggleRecording();
    await f.controller.toggleRecording();
    finish(); await first;
    expect(f.toggle).toHaveBeenCalledTimes(1);
  });
  it.each(["recording", "paused", "processing"] as const)("does not hide or lose the target while %s", status => {
    const f = fixture();
    const session = f.runtime.startOverlaySession("TextEdit");
    f.runtime.updateState({ status, activeSourceType: "microphone" });
    if (status === "processing") f.runtime.updateOverlaySession({ phase: "processing" });
    expect(f.controller.hide()).toBe(false);
    expect(f.runtime.getState().overlaySession?.id).toBe(session.id);
    expect(f.insertion.clearTargetApplication).not.toHaveBeenCalled();
    expect(f.hide).not.toHaveBeenCalled();
  });
  describe("while a manual paste retry is running", () => {
    const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
    function retrying() {
      const f = fixture();
      f.runtime.setOverlayReady();
      f.runtime.startOverlaySession("Editor");
      f.runtime.updateOverlaySession({ phase: "paste_failed", transcriptText: "טקסט" });
      const session = f.runtime.getState().overlaySession;
      f.runtime.setPasteRetrying(true);
      const hold = vi.spyOn(f.runtime, "requestRecordingHold");
      return { ...f, session, hold };
    }

    it.each(["retarget", "open"] as const)("%s neither captures nor clears anything", async action => {
      const f = retrying();
      await f.controller[action]();
      expect(f.insertion.captureCurrentTargetApplication).not.toHaveBeenCalled();
      expect(f.runtime.getState().overlaySession).toEqual(f.session);
    });

    it.each(["toggleRecording", "beginHold"] as const)("%s shows the window and touches nothing until the retry ends", async action => {
      const f = retrying();
      void f.controller[action]();
      await flush();
      expect(f.show).toHaveBeenCalledExactlyOnceWith(false);
      expect(f.insertion.captureCurrentTargetApplication).not.toHaveBeenCalled();
      expect(f.toggle).not.toHaveBeenCalled();
      expect(f.hold).not.toHaveBeenCalled();
      expect(f.runtime.getState().overlaySession).toEqual(f.session);
    });

    it("keeps a toggle press and starts it once the retry ends", async () => {
      const f = retrying();
      const press = f.controller.toggleRecording();
      await flush();
      f.runtime.setPasteRetrying(false);
      await press;
      expect(f.runtime.getState().overlaySession).toBeNull();
      expect(f.insertion.captureCurrentTargetApplication).toHaveBeenCalledOnce();
      expect(f.toggle).toHaveBeenCalledOnce();
    });

    it("lets a second press take back the one waiting behind the retry", async () => {
      const f = retrying();
      const press = f.controller.toggleRecording();
      await flush();
      await f.controller.toggleRecording();
      f.runtime.setPasteRetrying(false);
      await press;
      expect(f.toggle).not.toHaveBeenCalled();
      expect(f.runtime.getState().overlaySession?.id).toBe(f.session?.id);
      expect(f.insertion.captureCurrentTargetApplication).not.toHaveBeenCalled();
    });

    it("starts after a third press, which asks again", async () => {
      const f = retrying();
      const press = f.controller.toggleRecording();
      await flush();
      await f.controller.toggleRecording();
      await f.controller.toggleRecording();
      f.runtime.setPasteRetrying(false);
      await press;
      expect(f.toggle).toHaveBeenCalledOnce();
    });

    it("leaves an unknown paste result on screen for a waiting toggle", async () => {
      const f = retrying();
      const press = f.controller.toggleRecording();
      await flush();
      f.runtime.updateOverlaySession({ manualCopyOnly: true, insertionOutcome: "unknown" });
      f.runtime.setPasteRetrying(false);
      await press;
      expect(f.toggle).not.toHaveBeenCalled();
      expect(f.runtime.getState().overlaySession?.insertionOutcome).toBe("unknown");
    });

    it("leaves an unknown paste result on screen for a held key, through its release", async () => {
      const f = retrying();
      const press = f.controller.beginHold();
      await flush();
      f.runtime.updateOverlaySession({ manualCopyOnly: true, insertionOutcome: "unknown" });
      f.runtime.setPasteRetrying(false);
      await press;
      f.controller.endHold();
      expect(f.hold).not.toHaveBeenCalledWith("press");
      expect(f.runtime.getState().overlaySession?.insertionOutcome).toBe("unknown");
    });

    it("keeps a held key and starts it once the retry ends", async () => {
      const f = retrying();
      const press = f.controller.beginHold();
      await flush();
      f.runtime.setPasteRetrying(false);
      await press;
      expect(f.insertion.captureCurrentTargetApplication).toHaveBeenCalledOnce();
      expect(f.hold).toHaveBeenCalledExactlyOnceWith("press");
    });

    it("drops a held key let go during the wait and leaves the result showing", async () => {
      const f = retrying();
      const press = f.controller.beginHold();
      await flush();
      f.controller.endHold();
      f.hold.mockClear();
      f.runtime.setPasteRetrying(false);
      await press;
      expect(f.hold).not.toHaveBeenCalled();
      expect(f.hide).not.toHaveBeenCalled();
      expect(f.runtime.getState().overlaySession).toEqual(f.session);
      expect(f.insertion.captureCurrentTargetApplication).not.toHaveBeenCalled();
    });

    it("does not let the window close over a result it has yet to learn", () => {
      const f = retrying();
      expect(f.controller.hide()).toBe(false);
      expect(f.hide).not.toHaveBeenCalled();
      expect(f.runtime.getState().overlaySession).toEqual(f.session);
      f.runtime.setPasteRetrying(false);
      expect(f.controller.hide()).toBe(true);
    });
  });

  it("captures again once the retry has settled", async () => {
    const f = fixture();
    f.runtime.setPasteRetrying(true);
    f.runtime.setPasteRetrying(false);
    await f.controller.toggleRecording();
    expect(f.insertion.captureCurrentTargetApplication).toHaveBeenCalledOnce();
  });

  it("can dismiss a saved result after paste failure", () => {
    const f = fixture();
    f.runtime.startOverlaySession("TextEdit");
    f.runtime.updateOverlaySession({ phase: "paste_failed", transcriptId: "saved", transcriptText: "שלום" });
    expect(f.controller.hide()).toBe(true);
    expect(f.hide).toHaveBeenCalledTimes(1);
    expect(f.runtime.getState().overlaySession).toBeNull();
  });
  it("recaptures the target for the next dictation after a completed session", async () => {
    const f = fixture();
    f.runtime.startOverlaySession("Previous editor");
    f.runtime.updateOverlaySession({ phase: "success", transcriptText: "saved" });
    await f.controller.toggleRecording();
    expect(f.insertion.captureCurrentTargetApplication).toHaveBeenCalledTimes(1);
    expect(f.runtime.getState().overlaySession).toBeNull();
  });
  it("opening during processing neither changes the paste target nor toggles recording", async () => {
    const f = fixture();
    f.runtime.updateState({ status: "processing", activeSourceType: "microphone" });
    await f.controller.open();
    await f.controller.toggleRecording();
    expect(f.insertion.captureCurrentTargetApplication).not.toHaveBeenCalled();
    expect(f.toggle).not.toHaveBeenCalled();
  });
  it("passes a hold made while a dictation is being written to the window, keeping the paste target", async () => {
    const f = fixture();
    f.runtime.setOverlayReady();
    f.runtime.updateState({ status: "processing", activeSourceType: "microphone" });
    const send = vi.spyOn(f.runtime, "sendTo");
    await f.controller.beginHold();
    f.controller.endHold();
    expect(f.insertion.captureCurrentTargetApplication).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "press");
    expect(send).toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "release");
  });
  it("still ignores a hold while a file or video is being transcribed", async () => {
    const f = fixture();
    f.runtime.setOverlayReady();
    f.runtime.updateState({ status: "processing", activeSourceType: "imported_file" });
    const send = vi.spyOn(f.runtime, "sendTo");
    await f.controller.beginHold();
    expect(send).not.toHaveBeenCalledWith("overlay", IPC_CHANNELS.recordingHoldRequested, "press");
  });
});

describe("display-safe floating position", () => {
  const area = { x: -1920, y: 24, width: 1920, height: 1056 };
  it("retains a user-dragged position on a display with negative coordinates", () => {
    expect(clampOverlayPosition({ x: -800, y: 200, width: 344, height: 164 }, area)).toEqual({ x: -800, y: 200 });
  });
  it("clamps all edges after a display is removed or its work area changes", () => {
    expect(clampOverlayPosition({ x: 500, y: 2000, width: 344, height: 164 }, area)).toEqual({ x: -344, y: 916 });
    expect(clampOverlayPosition({ x: -3000, y: -100, width: 344, height: 164 }, area)).toEqual({ x: -1920, y: 24 });
  });
});
