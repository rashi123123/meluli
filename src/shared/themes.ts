/* A theme's palette seeds the design system's tokens; instrument.css derives the rest. */
export interface ThemePalette {
  chassis: string;
  sunken: string;
  page: string;
  hover: string;
  field: string;
  track: string;
  raised: string;
  raisedEnd: string;
  ink1: string;
  ink2: string;
  ink3: string;
  capsule: string;
  capsuleInk: string;
  signal: string;
  danger: string;
  ok: string;
  focus: string;
}

export interface ThemeSwatch {
  page: string;
  raised: string;
  ink: string;
  accent: string;
}

export interface ThemeDefinition {
  label: string;
  /** Sets the native window chrome, and picks the stylesheet's dark or light rules. */
  mode: "system" | "dark" | "light";
  /** Null means the stylesheet's own tokens, which already follow the mode. */
  palette: ThemePalette | null;
  swatch: ThemeSwatch;
}

export const THEME_IDS = [
  "system",
  "meluli-dark",
  "meluli-light",
  "nord",
  "dracula",
  "tokyo-night",
  "gruvbox",
  "rose-pine",
  "github-light",
  "solarized-light",
  "catppuccin-latte"
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = "system";

const MELULI_DARK_SWATCH: ThemeSwatch = { page: "#111113", raised: "#232327", ink: "#f4f4f5", accent: "#f1f1f2" };
const MELULI_LIGHT_SWATCH: ThemeSwatch = { page: "#e3e3e7", raised: "#ffffff", ink: "#17171a", accent: "#1b1b1f" };

function paletteTheme(label: string, mode: "dark" | "light", palette: ThemePalette): ThemeDefinition {
  return { label, mode, palette, swatch: { page: palette.page, raised: palette.raised, ink: palette.ink1, accent: palette.capsule } };
}

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  system: {
    label: "לפי המערכת",
    mode: "system",
    palette: null,
    swatch: MELULI_DARK_SWATCH
  },
  "meluli-dark": { label: "מלולי כהה", mode: "dark", palette: null, swatch: MELULI_DARK_SWATCH },
  "meluli-light": { label: "מלולי בהיר", mode: "light", palette: null, swatch: MELULI_LIGHT_SWATCH },
  nord: paletteTheme("Nord", "dark", {
    chassis: "#242933", sunken: "#2a303c", page: "#2e3440", hover: "#363d4b", field: "#3b4252", track: "#4c566a",
    raised: "#3b4252", raisedEnd: "#404859",
    ink1: "#eceff4", ink2: "#d8dee9", ink3: "#b4bdcc",
    capsule: "#88c0d0", capsuleInk: "#242933",
    signal: "#d57780", danger: "#f0b0b5", ok: "#a3be8c", focus: "#81a1c1"
  }),
  dracula: paletteTheme("Dracula", "dark", {
    chassis: "#191a21", sunken: "#21222c", page: "#282a36", hover: "#313341", field: "#383a4a", track: "#44475a",
    raised: "#343746", raisedEnd: "#3b3e50",
    ink1: "#f8f8f2", ink2: "#d6d6e0", ink3: "#b4b8cf",
    capsule: "#c9a6fb", capsuleInk: "#191a21",
    signal: "#ff5555", danger: "#ffa6a6", ok: "#50fa7b", focus: "#8be9fd"
  }),
  "tokyo-night": paletteTheme("Tokyo Night", "dark", {
    chassis: "#13141d", sunken: "#16161e", page: "#1a1b26", hover: "#232433", field: "#292e42", track: "#3b4261",
    raised: "#24283b", raisedEnd: "#292e42",
    ink1: "#c0caf5", ink2: "#a9b1d6", ink3: "#9099c2",
    capsule: "#7aa2f7", capsuleInk: "#13141d",
    signal: "#f7768e", danger: "#ff9db0", ok: "#9ece6a", focus: "#7dcfff"
  }),
  gruvbox: paletteTheme("Gruvbox", "dark", {
    chassis: "#1d2021", sunken: "#232526", page: "#282828", hover: "#32302f", field: "#3c3836", track: "#504945",
    raised: "#32302f", raisedEnd: "#3c3836",
    ink1: "#fbf1c7", ink2: "#d5c4a1", ink3: "#b8a88c",
    capsule: "#fabd2f", capsuleInk: "#1d2021",
    signal: "#fb4934", danger: "#fe9c8e", ok: "#b8bb26", focus: "#83a598"
  }),
  "rose-pine": paletteTheme("Rosé Pine", "dark", {
    chassis: "#121019", sunken: "#16141f", page: "#191724", hover: "#1f1d2e", field: "#26233a", track: "#393552",
    raised: "#1f1d2e", raisedEnd: "#26233a",
    ink1: "#e0def4", ink2: "#c4c0dc", ink3: "#9e9ab3",
    capsule: "#ebbcba", capsuleInk: "#191724",
    signal: "#eb6f92", danger: "#f29db5", ok: "#9ccfd8", focus: "#c4a7e7"
  }),
  "github-light": paletteTheme("GitHub Light", "light", {
    chassis: "#e6e9ed", sunken: "#f0f2f5", page: "#ffffff", hover: "#f3f5f7", field: "#eaeef2", track: "#d0d7de",
    raised: "#ffffff", raisedEnd: "#f6f8fa",
    ink1: "#1f2328", ink2: "#4e565e", ink3: "#5f6771",
    capsule: "#0969da", capsuleInk: "#ffffff",
    signal: "#cf222e", danger: "#b3141f", ok: "#1a7f37", focus: "#0969da"
  }),
  "solarized-light": paletteTheme("Solarized Light", "light", {
    chassis: "#e9e2cd", sunken: "#eee8d5", page: "#fdf6e3", hover: "#f3edda", field: "#eee8d5", track: "#dbd4bf",
    raised: "#fffaf0", raisedEnd: "#f5efdc",
    ink1: "#073642", ink2: "#3f5a63", ink3: "#53676e",
    capsule: "#1f6fa8", capsuleInk: "#fdf6e3",
    signal: "#dc322f", danger: "#b02320", ok: "#5f7a00", focus: "#268bd2"
  }),
  "catppuccin-latte": paletteTheme("Catppuccin Latte", "light", {
    chassis: "#dce0e8", sunken: "#e6e9ef", page: "#eff1f5", hover: "#e6e9ef", field: "#dfe3ea", track: "#ccd0da",
    raised: "#fafbfd", raisedEnd: "#f2f4f8",
    ink1: "#3c3f58", ink2: "#4c4f69", ink3: "#5c5f77",
    capsule: "#8839ef", capsuleInk: "#ffffff",
    signal: "#d20f39", danger: "#b80c30", ok: "#3a9326", focus: "#1e66f5"
  })
};

export function isThemeId(value: unknown): value is ThemeId {
  return THEME_IDS.includes(value as ThemeId);
}
