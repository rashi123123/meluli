/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  LONG_TRANSCRIPT_NOTIFICATION_MIN_DURATION_MS,
  buildTranscriptCompletionNotification,
  isLongTranscriptForNotification,
  shouldNotifyTranscriptCompletion
} from "@main/services/transcript-notification.service";

describe("isLongTranscriptForNotification", () => {
  it("treats long-duration transcripts as long", () => {
    expect(
      isLongTranscriptForNotification({
        durationMs: LONG_TRANSCRIPT_NOTIFICATION_MIN_DURATION_MS,
        text: "טקסט קצר"
      })
    ).toBe(true);
  });

  it("falls back to text length when duration is missing", () => {
    expect(
      isLongTranscriptForNotification({
        durationMs: null,
        text: "א".repeat(400)
      })
    ).toBe(true);
  });

  it("does not notify for short transcripts", () => {
    expect(
      isLongTranscriptForNotification({
        durationMs: 15_000,
        text: "טקסט קצר"
      })
    ).toBe(false);
  });
});

describe("shouldNotifyTranscriptCompletion", () => {
  it("only returns true when enabled, long, and unfocused", () => {
    expect(
      shouldNotifyTranscriptCompletion({
        settings: { completionNotificationsEnabled: true },
        transcript: { durationMs: 120_000, text: "טקסט" },
        appFocused: false
      })
    ).toBe(true);

    expect(
      shouldNotifyTranscriptCompletion({
        settings: { completionNotificationsEnabled: false },
        transcript: { durationMs: 120_000, text: "טקסט" },
        appFocused: false
      })
    ).toBe(false);

    expect(
      shouldNotifyTranscriptCompletion({
        settings: { completionNotificationsEnabled: true },
        transcript: { durationMs: 120_000, text: "טקסט" },
        appFocused: true
      })
    ).toBe(false);
  });
});

describe("buildTranscriptCompletionNotification", () => {
  it("uses a source label when available", () => {
    expect(
      buildTranscriptCompletionNotification({
        sourceTitle: "שיעור עברית",
        importedFileName: null
      }).body
    ).toContain("שיעור עברית");
  });
});
