import { THEMES, type ThemeId, type ThemePalette } from "@shared/themes";

const PALETTE_TOKENS: Record<keyof ThemePalette, string> = {
  chassis: "--chassis",
  sunken: "--s-1",
  page: "--s0",
  hover: "--s1",
  field: "--s2",
  track: "--s3",
  raised: "--raised",
  raisedEnd: "--raised-end",
  ink1: "--ink1",
  ink2: "--ink2",
  ink3: "--ink3",
  capsule: "--capsule",
  capsuleInk: "--capsule-ink",
  signal: "--signal",
  danger: "--danger",
  ok: "--ok",
  focus: "--focus"
};

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  const { palette } = THEMES[id];

  if (palette) root.dataset.theme = id;
  else delete root.dataset.theme;

  for (const [key, token] of Object.entries(PALETTE_TOKENS) as [keyof ThemePalette, string][]) {
    if (palette) root.style.setProperty(token, palette[key]);
    else root.style.removeProperty(token);
  }
}
