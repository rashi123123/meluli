import type { MicrophonePermissionStatus } from "@shared/types";

/** The user or a profile turned the microphone off for the app; only System Settings can turn it back on. */
export function isMicrophoneBlocked(status: MicrophonePermissionStatus | string | null | undefined): boolean {
  return status === "denied" || status === "restricted";
}
