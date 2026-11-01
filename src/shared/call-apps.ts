import type { CallAppKind } from "./types";

export interface CallApp {
  id: string;
  kind: CallAppKind;
  /** Bundle id prefixes, so helper processes count as the same app. */
  prefixes: string[];
}

export const CALL_APPS: readonly CallApp[] = [
  { id: "zoom", kind: "zoom", prefixes: ["us.zoom"] },
  { id: "teams", kind: "teams", prefixes: ["com.microsoft.teams"] },
  { id: "chrome", kind: "browser", prefixes: ["com.google.Chrome"] },
  { id: "helium", kind: "browser", prefixes: ["net.imput.helium"] },
  { id: "safari", kind: "browser", prefixes: ["com.apple.Safari", "com.apple.WebKit"] },
  { id: "arc", kind: "browser", prefixes: ["company.thebrowser"] },
  { id: "edge", kind: "browser", prefixes: ["com.microsoft.edgemac"] },
  { id: "firefox", kind: "browser", prefixes: ["org.mozilla.firefox"] },
  { id: "brave", kind: "browser", prefixes: ["com.brave.Browser"] }
];

/** Process taps exist from macOS 14.2. */
export function supportsCallCapture(systemVersion: string): boolean {
  const [major = 0, minor = 0] = systemVersion.split(".").map(Number);
  return major > 14 || (major === 14 && minor >= 2);
}

export function callAppForBundle(bundleId: string): CallApp | null {
  return CALL_APPS.find((app) => app.prefixes.some((prefix) => bundleId.startsWith(prefix))) ?? null;
}

export function callAppById(id: string): CallApp | null {
  return CALL_APPS.find((app) => app.id === id) ?? null;
}
