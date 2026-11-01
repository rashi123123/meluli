/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { THEME_IDS, THEMES, type ThemePalette } from "@shared/themes";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const palettes = THEME_IDS.flatMap((id) => {
  const { palette } = THEMES[id];
  return palette ? [[id, palette] as const] : [];
});

const TEXT = 4.5;
const SIGNAL = 3;
const everySurface: (keyof ThemePalette)[] = ["chassis", "sunken", "page", "hover", "field", "raised", "raisedEnd"];

describe("themes", () => {
  it("offers ten themes besides following the system", () => {
    expect(THEME_IDS.filter((id) => id !== "system")).toHaveLength(10);
  });

  it.each(palettes)("%s keeps every ink readable", (_id, palette) => {
    for (const surface of everySurface) {
      expect(contrast(palette.ink1, palette[surface]), `ink1 on ${surface}`).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(palette.ink2, palette[surface]), `ink2 on ${surface}`).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(palette.ink3, palette[surface]), `ink3 on ${surface}`).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(palette.danger, palette[surface]), `danger on ${surface}`).toBeGreaterThanOrEqual(TEXT);
    }
    expect(contrast(palette.ink1, palette.track), "ink1 on track").toBeGreaterThanOrEqual(TEXT);
    expect(contrast(palette.ink2, palette.track), "ink2 on track").toBeGreaterThanOrEqual(TEXT);
  });

  it.each(palettes)("%s keeps the capsule readable both ways round", (_id, palette) => {
    expect(contrast(palette.capsuleInk, palette.capsule), "ink on capsule").toBeGreaterThanOrEqual(TEXT);
    expect(contrast(palette.capsule, palette.raised), "stop label on its button").toBeGreaterThanOrEqual(TEXT);
    expect(contrast(palette.capsule, palette.raisedEnd), "stop label on its button").toBeGreaterThanOrEqual(TEXT);
  });

  it.each(palettes)("%s keeps signals visible", (_id, palette) => {
    for (const signal of ["signal", "ok", "focus"] as const) {
      expect(contrast(palette[signal], palette.page), `${signal} on page`).toBeGreaterThanOrEqual(SIGNAL);
      expect(contrast(palette[signal], palette.sunken), `${signal} on sunken`).toBeGreaterThanOrEqual(SIGNAL);
    }
  });
});
