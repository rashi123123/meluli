import type { AppStateSnapshot } from "@shared/types";

export type RecorderHudShortcutDecision =
  | {
      action: "cancel-active";
    }
  | {
      action: "toggle-overlay";
      showOverlay: boolean;
    };

export function resolveRecorderHudShortcutDecision(
  snapshot: AppStateSnapshot
): RecorderHudShortcutDecision {
  if (snapshot.status === "youtube_downloading") {
    return { action: "cancel-active" };
  }

  if (snapshot.status === "processing" && snapshot.activeSourceType !== "microphone") {
    return { action: "cancel-active" };
  }

  return {
    action: "toggle-overlay",
    showOverlay: !(snapshot.status === "processing" && snapshot.activeSourceType === "microphone")
  };
}
