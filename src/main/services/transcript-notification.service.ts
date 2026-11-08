import { BrowserWindow, Notification } from "electron";
import { he } from "@shared/locale";
import type { AppSettings, TranscriptRecord } from "@shared/types";

export const LONG_TRANSCRIPT_NOTIFICATION_MIN_DURATION_MS = 60_000;
export const LONG_TRANSCRIPT_NOTIFICATION_MIN_TEXT_LENGTH = 400;

export function isLongTranscriptForNotification(
  transcript: Pick<TranscriptRecord, "durationMs" | "text">
): boolean {
  if (typeof transcript.durationMs === "number" && transcript.durationMs >= LONG_TRANSCRIPT_NOTIFICATION_MIN_DURATION_MS) {
    return true;
  }

  return transcript.text.trim().length >= LONG_TRANSCRIPT_NOTIFICATION_MIN_TEXT_LENGTH;
}

export function shouldNotifyTranscriptCompletion(params: {
  settings: Pick<AppSettings, "completionNotificationsEnabled">;
  transcript: Pick<TranscriptRecord, "durationMs" | "text">;
  appFocused: boolean;
}): boolean {
  return (
    params.settings.completionNotificationsEnabled &&
    !params.appFocused &&
    isLongTranscriptForNotification(params.transcript)
  );
}

export function buildTranscriptCompletionNotification(transcript: Pick<TranscriptRecord, "sourceTitle" | "importedFileName">) {
  const subject = transcript.sourceTitle ?? transcript.importedFileName ?? null;
  return {
    title: he.completionNotificationTitle,
    body: subject ? `${he.completionNotificationBody} ${subject}` : he.completionNotificationBody
  };
}

/** Shows the system notification for a long transcript finished while Meluli was in the background. */
export function notifyTranscriptCompletion(
  settings: Pick<AppSettings, "completionNotificationsEnabled">,
  transcript: TranscriptRecord,
  onClick: () => void
): void {
  if (!Notification.isSupported()) return;
  if (!shouldNotifyTranscriptCompletion({ settings, transcript, appFocused: BrowserWindow.getFocusedWindow() !== null })) return;
  const notification = new Notification(buildTranscriptCompletionNotification(transcript));
  notification.on("click", onClick);
  notification.show();
}
