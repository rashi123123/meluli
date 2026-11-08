/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { isGlobalShortcut, toElectronAccelerator, isReservedShortcut } from "@/lib/shortcut";

describe("toElectronAccelerator", () => {
  it("normalizes modifiers and uppercase characters", () => {
    expect(
      toElectronAccelerator({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        key: "r"
      })
    ).toBe("Control+Shift+R");
  });

  it("ignores modifier-only presses", () => {
    expect(
      toElectronAccelerator({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: "Control"
      })
    ).toBeNull();
  });

  const press = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };

  it("reads the physical key so a Hebrew layout stays registrable", () => {
    expect(toElectronAccelerator({ ...press, key: "ר", code: "KeyR" })).toBe("Control+Shift+R");
    expect(toElectronAccelerator({ ...press, key: "!", code: "Digit1" })).toBe("Control+Shift+1");
    expect(toElectronAccelerator({ ...press, key: "ת", code: "Comma" })).toBe("Control+Shift+,");
  });

  it("names the keys Electron spells differently from the browser", () => {
    expect(toElectronAccelerator({ ...press, key: " ", code: "Space" })).toBe("Control+Shift+Space");
    expect(toElectronAccelerator({ ...press, key: "ArrowUp", code: "ArrowUp" })).toBe("Control+Shift+Up");
    expect(toElectronAccelerator({ ...press, key: "F5", code: "F5" })).toBe("Control+Shift+F5");
  });

  it("ignores keys that are not part of a shortcut", () => {
    expect(toElectronAccelerator({ ...press, key: "CapsLock", code: "CapsLock" })).toBeNull();
    expect(toElectronAccelerator({ ...press, key: "Dead" })).toBeNull();
  });

  it("keeps a key macOS reports as dead under Option", () => {
    expect(toElectronAccelerator({ ...press, altKey: true, key: "Dead", code: "KeyE" })).toBe("Control+Alt+Shift+E");
  });
});

describe("isGlobalShortcut", () => {
  it.each([["Control+Shift+R", true], ["Command+K", true], ["Alt+Space", true], ["F5", true], ["Shift+F12", true], ["R", false], ["Shift+R", false], ["Space", false]])("%s is %s", (accelerator, expected) => {
    expect(isGlobalShortcut(accelerator)).toBe(expected);
  });
});

describe("isReservedShortcut", () => {
  it("refuses the combos macOS and every app rely on", () => {
    for (const combo of ["Command+V", "Command+C", "Command+Z", "Command+Shift+Z", "Command+Q", "Command+Space", "Command+Tab", "Command+Escape"]) {
      expect(isReservedShortcut(combo)).toBe(true);
    }
  });
  it("keeps combos that add Control or Option, or that macOS leaves free", () => {
    for (const combo of ["Control+Shift+R", "Command+Alt+V", "Control+Command+V", "Command+Shift+V", "Command+R"]) {
      expect(isReservedShortcut(combo)).toBe(false);
    }
  });
});
