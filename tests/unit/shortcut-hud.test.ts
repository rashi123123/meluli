/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { resolveRecorderHudShortcutDecision } from "@main/shortcut-hud";

describe("resolveRecorderHudShortcutDecision", () => {
  it("opens the HUD and starts the overlay path from idle", () => {
    expect(
      resolveRecorderHudShortcutDecision({
        status: "idle",
        timerStartedAt: null,
        activeSourceType: null,
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null
      })
    ).toEqual({
      action: "toggle-overlay",
      showOverlay: true
    });
  });

  it("keeps the HUD visible and routes stop/cancel through the overlay for microphone sessions", () => {
    expect(
      resolveRecorderHudShortcutDecision({
        status: "recording",
        timerStartedAt: Date.now(),
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null
      })
    ).toEqual({
      action: "toggle-overlay",
      showOverlay: true
    });

    expect(
      resolveRecorderHudShortcutDecision({
        status: "processing",
        timerStartedAt: null,
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null
      })
    ).toEqual({
      action: "toggle-overlay",
      showOverlay: false
    });
  });

  it("cancels non-microphone work instead of opening the HUD", () => {
    expect(
      resolveRecorderHudShortcutDecision({
        status: "processing",
        timerStartedAt: null,
        activeSourceType: "youtube",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null
      })
    ).toEqual({
      action: "cancel-active"
    });

    expect(
      resolveRecorderHudShortcutDecision({
        status: "youtube_downloading",
        timerStartedAt: null,
        activeSourceType: "youtube",
        currentYoutubeJob: {
          url: "https://youtu.be/demo"
        },
        pendingYoutubeJob: null,
        lastError: null
      })
    ).toEqual({
      action: "cancel-active"
    });
  });
});
