import { nativeTheme } from "electron";
import { DEFAULT_THEME, THEMES, type ThemeId } from "@shared/themes";

let currentTheme: ThemeId = DEFAULT_THEME;

export function applyTheme(id: ThemeId): void {
  currentTheme = id;
  nativeTheme.themeSource = THEMES[id].mode;
}

export function getCurrentTheme(): ThemeId {
  return currentTheme;
}

export function getWindowBackground(): string {
  return THEMES[currentTheme].palette?.page ?? (nativeTheme.shouldUseDarkColors ? "#111113" : "#fbfbfc");
}
