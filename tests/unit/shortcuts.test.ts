/* @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from "vitest";

const globalShortcutMock = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  unregisterAll: vi.fn()
}));

vi.mock("electron", () => ({
  globalShortcut: {
    register: globalShortcutMock.register,
    unregister: globalShortcutMock.unregister,
    unregisterAll: globalShortcutMock.unregisterAll
  }
}));

import { he } from "@shared/locale";
import { ShortcutManager } from "@main/shortcuts";

describe("ShortcutManager", () => {
  beforeEach(() => {
    globalShortcutMock.register.mockReset();
    globalShortcutMock.unregister.mockReset();
    globalShortcutMock.unregisterAll.mockReset();
    globalShortcutMock.register.mockReturnValue(true);
  });

  it("borrows Cmd-Z only for the undo window and gives it back", () => {
    const onUndo = vi.fn();
    const manager = new ShortcutManager({ onRecordingToggle: vi.fn(), onOverlayOpen: vi.fn(), onUndo });
    manager.setUndoActive(true);
    expect(globalShortcutMock.register).toHaveBeenCalledTimes(1);
    expect(globalShortcutMock.register.mock.calls[0][0]).toBe("CommandOrControl+Z");
    globalShortcutMock.register.mock.calls[0][1]();
    expect(onUndo).toHaveBeenCalledOnce();
    manager.setUndoActive(true);
    expect(globalShortcutMock.register).toHaveBeenCalledTimes(1);
    manager.setUndoActive(false);
    expect(globalShortcutMock.unregister).toHaveBeenCalledWith("CommandOrControl+Z");
  });

  it("registers independent recording and overlay shortcuts", () => {
    const onRecordingToggle = vi.fn();
    const onOverlayOpen = vi.fn();
    const manager = new ShortcutManager({
      onRecordingToggle,
      onOverlayOpen
    });

    const bindings = manager.registerAll({
      recording: "Control+Shift+R",
      overlay: "Control+Shift+H"
    });

    expect(bindings).toEqual({
      recording: "Control+Shift+R",
      overlay: "Control+Shift+H"
    });
    expect(globalShortcutMock.register).toHaveBeenNthCalledWith(1, "Control+Shift+R", onRecordingToggle);
    expect(globalShortcutMock.register).toHaveBeenNthCalledWith(2, "Control+Shift+H", onOverlayOpen);
  });

  it("preserves the other binding when updating only the recording shortcut", () => {
    const manager = new ShortcutManager({
      onRecordingToggle: vi.fn(),
      onOverlayOpen: vi.fn()
    });

    manager.registerAll({
      recording: "Control+Shift+R",
      overlay: "Control+Shift+H"
    });
    globalShortcutMock.register.mockClear();
    globalShortcutMock.unregister.mockClear();

    const nextRecording = manager.setRecordingShortcut("Control+Shift+T");

    expect(nextRecording).toBe("Control+Shift+T");
    expect(globalShortcutMock.unregister).toHaveBeenCalledWith("Control+Shift+R");
    expect(globalShortcutMock.unregister).toHaveBeenCalledWith("Control+Shift+H");
    expect(globalShortcutMock.register).toHaveBeenNthCalledWith(1, "Control+Shift+T", expect.any(Function));
    expect(globalShortcutMock.register).toHaveBeenNthCalledWith(2, "Control+Shift+H", expect.any(Function));
  });

  it("claims Esc only while asked to and hands it back afterwards", () => {
    const onEscape = vi.fn();
    const manager = new ShortcutManager({ onRecordingToggle: vi.fn(), onOverlayOpen: vi.fn(), onEscape });
    manager.setEscapeActive(true);
    manager.setEscapeActive(true);
    expect(globalShortcutMock.register.mock.calls.filter(([key]) => key === "Escape")).toHaveLength(1);
    globalShortcutMock.register.mock.calls.find(([key]) => key === "Escape")![1]();
    expect(onEscape).toHaveBeenCalledOnce();
    manager.setEscapeActive(false);
    expect(globalShortcutMock.unregister).toHaveBeenCalledWith("Escape");
  });

  it("rejects duplicate accelerators for the two actions", () => {
    const manager = new ShortcutManager({
      onRecordingToggle: vi.fn(),
      onOverlayOpen: vi.fn()
    });

    expect(() =>
      manager.registerAll({
        recording: "Control+Shift+R",
        overlay: "Control+Shift+R"
      })
    ).toThrow(he.shortcutConflict);
  });

  it("restores the working shortcuts when a change cannot be claimed", () => {
    const manager = new ShortcutManager({ onRecordingToggle: vi.fn(), onOverlayOpen: vi.fn() });
    const current = { recording: "Control+Shift+R", overlay: "Control+Shift+H" };
    manager.registerAll(current);
    globalShortcutMock.register.mockClear();
    globalShortcutMock.register.mockImplementation((accelerator: string) => accelerator !== "Control+Shift+K");

    expect(() => manager.registerAll({ ...current, recording: "Control+Shift+K" })).toThrow(he.shortcutRegisterFailed);
    expect(globalShortcutMock.register.mock.calls.map(([accelerator]) => accelerator).slice(-2)).toEqual(["Control+Shift+R", "Control+Shift+H"]);
  });

  it("reports an accelerator Electron refuses to parse as a failed registration", () => {
    const manager = new ShortcutManager({ onRecordingToggle: vi.fn(), onOverlayOpen: vi.fn() });
    globalShortcutMock.register.mockImplementation(() => { throw new Error("conversion failure"); });

    expect(() => manager.registerAll({ recording: "Control+Shift+R", overlay: "Control+Shift+H" })).toThrow(he.shortcutRegisterFailed);
  });
});
