import { getRemainingEstimateMs } from "@shared/processing-estimate";
import { he } from "@shared/locale";
import type { AppRuntimeStatus, AppStateSnapshot } from "@shared/types";

export type TrayVisualState = "idle" | "recording" | "paused" | "processing" | "ready";

export interface TrayPresentation {
  iconState: TrayVisualState;
  title: string;
  menuLabel: string;
  shouldRefresh: boolean;
}

const STATUS_LABELS: Record<AppRuntimeStatus, string> = {
  idle: he.idle,
  recording: he.recording,
  paused: he.paused,
  youtube_downloading: he.trayDownloading,
  processing: he.processing,
  error: he.error
};

function formatSeconds(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

export function buildTrayPresentation({
  snapshot,
  now,
  readyUntilMs
}: {
  snapshot: AppStateSnapshot;
  now: number;
  readyUntilMs: number | null;
}): TrayPresentation {
  // The floating window is its own status display, so the menu bar rests beside it.
  if (snapshot.overlaySession) {
    return {
      iconState: "idle",
      title: "",
      menuLabel: STATUS_LABELS[snapshot.status],
      shouldRefresh: false
    };
  }

  // Dictation owns the menu bar while it runs. A call shows when nothing else does.
  if (snapshot.status === "idle" && snapshot.call?.recording) {
    const time = formatSeconds(Math.max(0, now - snapshot.call.recording.startedAt));
    return { iconState: "recording", title: time, menuLabel: `${he.callRecording} ${time}`, shouldRefresh: true };
  }
  if (snapshot.status === "idle" && snapshot.call?.processing) {
    const percent = Math.round(snapshot.call.processing.progressRatio * 100);
    return { iconState: "processing", title: "", menuLabel: `${he.callProcessing} ${percent}%`, shouldRefresh: false };
  }

  const readyActive =
    snapshot.status === "idle" &&
    readyUntilMs !== null &&
    readyUntilMs > now;

  if (readyActive) {
    return {
      iconState: "ready",
      title: "",
      menuLabel: he.idle,
      shouldRefresh: true
    };
  }

  switch (snapshot.status) {
    case "recording": {
      const elapsedMs = snapshot.timerStartedAt ? Math.max(0, now - snapshot.timerStartedAt) : 0;
      const time = formatSeconds(elapsedMs);
      return {
        iconState: "recording",
        title: time,
        menuLabel: `${he.recording} ${time}`,
        shouldRefresh: true
      };
    }
    case "paused": {
      const elapsedMs = snapshot.timerStartedAt ? Math.max(0, snapshot.timerStartedAt) : 0;
      const time = formatSeconds(elapsedMs);
      return {
        iconState: "paused",
        title: time,
        menuLabel: `${he.paused} ${time}`,
        shouldRefresh: true
      };
    }
    case "youtube_downloading": {
      return {
        iconState: "processing",
        title: he.trayDownloading,
        menuLabel: he.trayDownloading,
        shouldRefresh: false
      };
    }
    case "processing": {
      const remainingMs =
        snapshot.processingStartedAt && snapshot.processingEstimateMs
          ? getRemainingEstimateMs({
              processingStartedAt: snapshot.processingStartedAt,
              processingEstimateMs: snapshot.processingEstimateMs,
              now
            })
          : null;

      if (remainingMs === null || remainingMs < 1000) {
        return { iconState: "processing", title: "", menuLabel: he.processing, shouldRefresh: false };
      }

      const time = formatSeconds(remainingMs);
      return {
        iconState: "processing",
        title: `~${time}`,
        menuLabel: `${he.processing} · ${he.processingEstimatePrefix}${time}`,
        shouldRefresh: true
      };
    }
    case "error":
      return {
        iconState: "idle",
        title: "",
        menuLabel: he.error,
        shouldRefresh: false
      };
    case "idle":
    default:
      return {
        iconState: "idle",
        title: "",
        menuLabel: he.idle,
        shouldRefresh: false
      };
  }
}
