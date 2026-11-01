import { describe, expect, it } from "vitest";
import { clampOverlayPosition, presetOverlayPosition } from "../../src/main/overlay-position";
import { overlayPositionSchema, appSettingsSchema } from "../../src/shared/schemas";

const workArea = { x: 100, y: 50, width: 1000, height: 800 };
const size = { width: 200, height: 100 };

describe("overlay position presets", () => {
  it.each([
    ["top", 500, 74], ["bottom", 500, 726], ["left", 124, 400], ["right", 876, 400],
    ["top-left", 124, 74], ["top-right", 876, 74], ["bottom-left", 124, 726], ["bottom-right", 876, 726]
  ] as const)("%s lands at its place in the work area", (preset, x, y) => {
    expect(presetOverlayPosition(preset, size, workArea)).toEqual({ x, y });
  });

  it("stays on a display too small for the margin", () => {
    const small = { x: 0, y: 0, width: 210, height: 110 };
    const position = presetOverlayPosition("bottom-right", size, small);
    expect(clampOverlayPosition({ ...size, ...position }, small)).toEqual({ x: 0, y: 0 });
  });

  it("keeps the dragged position unless the user chooses otherwise", () => {
    expect(appSettingsSchema.parse({}).overlayPosition).toBe("last");
    expect(overlayPositionSchema.safeParse("middle").success).toBe(false);
  });
});
