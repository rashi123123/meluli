/**
 * The pasted copy follows the app it lands in. History always keeps the full text.
 * Unknown apps get the text unchanged, so only apps listed here are ever affected.
 */

export type TargetKind = "chat" | "terminal" | "other";

const CHAT_APPS = new Set([
  "com.tinyspeck.slackmacgap",
  "net.whatsapp.WhatsApp",
  "desktop.WhatsApp",
  "ru.keepcoder.Telegram",
  "org.telegram.desktop",
  "com.apple.MobileSMS",
  "com.hnc.Discord",
  "org.whispersystems.signal-desktop",
  "com.microsoft.teams2",
  "com.microsoft.teams",
  "com.facebook.archon",
  "com.facebook.archon.developerID"
]);

/** Terminals: a paste there is a command line, so it is shaped as one and kept literal. */
export const TERMINAL_APPS: ReadonlySet<string> = new Set([
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "io.alacritty",
  "com.github.wez.wezterm",
  "co.zeit.hyper"
]);

export function targetKind(bundleId: string | null | undefined): TargetKind {
  if (!bundleId) return "other";
  if (TERMINAL_APPS.has(bundleId)) return "terminal";
  if (CHAT_APPS.has(bundleId)) return "chat";
  return "other";
}

/** Control characters other than tab and line break, which a paste never needs. In a terminal ESC can end a
 * bracketed paste and a carriage return runs the line, so text from a flow's model could run a command. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** The text any paste may carry: carriage returns become line breaks and other control characters go. */
export function withoutControls(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(CONTROL, "");
}

export function formatForTarget(text: string, bundleId: string | null | undefined): string {
  const kind = targetKind(bundleId);
  text = withoutControls(text);
  // A pasted line break can run a command, so a terminal gets one line.
  if (kind === "terminal") return text.replace(/[\s\u2028\u2029]*[\n\u2028\u2029]+[\s\u2028\u2029]*/gu, " ").trim();
  if (kind !== "chat") return text;

  // A chat message reads as one block, and a single line goes without the closing period.
  const lines = text.replace(/\n{2,}/gu, "\n").trim();
  if (lines.includes("\n") || /[.!?]\s/u.test(lines)) return lines;
  return /[^.]\.$/u.test(lines) ? lines.slice(0, -1) : lines;
}
