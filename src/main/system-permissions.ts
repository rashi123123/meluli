import { shell, systemPreferences } from "electron";
import { microphonePermissionStatusSchema } from "@shared/schemas";
import { isMockMode } from "./config/mock-mode";

export function microphoneStatus(): "granted" | "denied" | "not-determined" | "restricted" | "unknown" {
  if (isMockMode()) {
    return "granted";
  }

  try {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    return microphonePermissionStatusSchema.parse(status);
  } catch {
    return "unknown";
  }
}

export function accessibilityStatus(prompt = false): "granted" | "denied" | "unknown" {
  if (isMockMode()) {
    return "granted";
  }

  if (process.platform !== "darwin") {
    return "unknown";
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt) ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

export function openPrivacySettingsPane(kind: "Microphone" | "Accessibility" | "ListenEvent" | "AudioCapture"): Promise<boolean> {
  if (process.platform !== "darwin") {
    return Promise.resolve(false);
  }

  return shell
    .openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${kind}`)
    .then(() => true)
    .catch(() => false);
}
