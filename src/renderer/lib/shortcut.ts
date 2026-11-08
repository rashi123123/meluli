export interface ShortcutLikeEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}

const ignoredKeys = ["Control", "Shift", "Alt", "AltGraph", "Meta", "CapsLock", "Fn", "Dead", "Process", "Unidentified"];
const namedKeys: Record<string, string> = {
  " ": "Space", Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Backquote: "`", Comma: ",", Period: ".", Slash: "/"
};

/** The physical key, so a Hebrew layout or ⌥ still yields the Latin key Electron can register. */
function resolveKey({ code = "", key }: ShortcutLikeEvent): string {
  const physical = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (physical) return physical[1] ?? physical[2];
  return namedKeys[code] ?? namedKeys[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function toElectronAccelerator(event: ShortcutLikeEvent): string | null {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Command");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  const key = resolveKey(event);
  if (ignoredKeys.includes(key)) {
    return null;
  }

  return [...modifiers, key].join("+");
}

/** A global shortcut without a real modifier would swallow that key in every app. */
export function isGlobalShortcut(accelerator: string): boolean {
  const parts = accelerator.split("+");
  return /^F\d{1,2}$/.test(parts.at(-1) ?? "") || parts.slice(0, -1).some(part => part !== "Shift");
}

const RESERVED_COMMAND_KEYS = new Set(["C", "V", "X", "Z", "A", "Q", "W", "H", "M", "Tab", "Space"]);

/** Combos macOS and every app already rely on; claiming one globally would take it from them. */
export function isReservedShortcut(accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = parts.at(-1) ?? "", modifiers = parts.slice(0, -1);
  if (key === "Escape") return true;
  if (!modifiers.includes("Command") || modifiers.includes("Control") || modifiers.includes("Alt")) return false;
  const shifted = modifiers.includes("Shift");
  return shifted ? key === "Z" : RESERVED_COMMAND_KEYS.has(key);
}

const shortcutSymbols: Record<string, string> = {
  Control: "⌃", Ctrl: "⌃", Command: "⌘", Cmd: "⌘", CommandOrControl: "⌘", CmdOrCtrl: "⌘",
  Alt: "⌥", Option: "⌥", Shift: "⇧", Enter: "↩", Return: "↩", Space: "␣", Tab: "⇥",
  Backspace: "⌫", Delete: "⌦", Escape: "⎋", Esc: "⎋", Up: "↑", Down: "↓", Left: "←", Right: "→"
};

/** The way macOS menus write a shortcut, for example ⌃⇧R. */
export function formatShortcut(accelerator: string): string {
  return accelerator.split("+").map(part => shortcutSymbols[part] ?? part).join("");
}

const ariaKeys: Record<string, string> = { Command: "Meta", Cmd: "Meta", CommandOrControl: "Meta", CmdOrCtrl: "Meta", Ctrl: "Control", Option: "Alt", Space: "Space", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Esc: "Escape", Return: "Enter" };

/** The same accelerator in aria-keyshortcuts form, for example Control+Shift+R. */
export function toAriaKeyShortcuts(accelerator: string): string {
  return accelerator.split("+").map(part => ariaKeys[part] ?? part).join("+");
}
