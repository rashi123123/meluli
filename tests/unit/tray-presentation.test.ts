/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { buildTrayPresentation } from "@main/tray-presentation";

describe("buildTrayPresentation", () => {
  it("shows recording elapsed time in the background", () => {
    const now = 20_000;
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "recording",
        timerStartedAt: 8_000,
        processingStartedAt: null,
        processingEstimateMs: null,
        processingProgressRatio: null,
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: null
      },
      now,
      readyUntilMs: null
    });

    expect(presentation).toEqual({
      iconState: "recording",
      title: "00:12",
      menuLabel: "מקליטים 00:12",
      shouldRefresh: true
    });
  });

  it("shows paused elapsed time without treating it like a timestamp", () => {
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "paused",
        timerStartedAt: 12_000,
        processingStartedAt: null,
        processingEstimateMs: null,
        processingProgressRatio: null,
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: null
      },
      now: 90_000,
      readyUntilMs: null
    });

    expect(presentation).toEqual({
      iconState: "paused",
      title: "00:12",
      menuLabel: "בהשהיה 00:12",
      shouldRefresh: true
    });
  });

  it("shows processing ETA when an estimate exists", () => {
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "processing",
        timerStartedAt: null,
        processingStartedAt: 5_000,
        processingEstimateMs: 20_000,
        processingProgressRatio: 0.1,
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: null
      },
      now: 7_000,
      readyUntilMs: null
    });

    expect(presentation).toEqual({
      iconState: "processing",
      title: "~00:18",
      menuLabel: "מתמללים · כ־00:18",
      shouldRefresh: true
    });
  });

  it("drops the estimate in its last second instead of showing zero", () => {
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "processing",
        timerStartedAt: null,
        processingStartedAt: 5_000,
        processingEstimateMs: 20_000,
        processingProgressRatio: 0.1,
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: null
      },
      now: 24_500,
      readyUntilMs: null
    });

    expect(presentation).toEqual({
      iconState: "processing",
      title: "",
      menuLabel: "מתמללים",
      shouldRefresh: false
    });
  });

  it("shows compact download text for YouTube background work", () => {
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "youtube_downloading",
        timerStartedAt: null,
        processingStartedAt: null,
        processingEstimateMs: null,
        processingProgressRatio: null,
        activeSourceType: "youtube",
        currentYoutubeJob: { url: "https://youtu.be/demo" },
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: null
      },
      now: 0,
      readyUntilMs: null
    });

    expect(presentation).toEqual({
      iconState: "processing",
      title: "מורידים",
      menuLabel: "מורידים",
      shouldRefresh: false
    });
  });

  it("shows a short ready state while idle when a ready window is active", () => {
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "idle",
        timerStartedAt: null,
        processingStartedAt: null,
        processingEstimateMs: null,
        processingProgressRatio: null,
        activeSourceType: null,
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: null
      },
      now: 1_000,
      readyUntilMs: 8_000
    });

    expect(presentation).toEqual({
      iconState: "ready",
      title: "",
      menuLabel: "מוכנים",
      shouldRefresh: true
    });
  });

  it("rests while the floating window shows the recording", () => {
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "recording",
        timerStartedAt: 1_000,
        processingStartedAt: null,
        processingEstimateMs: null,
        processingProgressRatio: null,
        activeSourceType: "microphone",
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: {
          id: "overlay",
          phase: "recording",
          transcriptId: null,
          transcriptText: null,
          targetAppName: null,
          lastErrorCode: null
        }
      },
      now: 5_000,
      readyUntilMs: null
    });

    expect(presentation).toEqual({
      iconState: "idle",
      title: "",
      menuLabel: "מקליטים",
      shouldRefresh: false
    });
  });

  it("shows no ready state while a floating-window session is open", () => {
    const presentation = buildTrayPresentation({
      snapshot: {
        status: "idle",
        timerStartedAt: null,
        processingStartedAt: null,
        processingEstimateMs: null,
        processingProgressRatio: null,
        activeSourceType: null,
        currentYoutubeJob: null,
        pendingYoutubeJob: null,
        lastError: null,
        overlaySession: {
          id: "overlay",
          phase: "success",
          transcriptId: null,
          transcriptText: null,
          targetAppName: null,
          lastErrorCode: null
        }
      },
      now: 1_000,
      readyUntilMs: 8_000
    });

    expect(presentation.iconState).toBe("idle");
    expect(presentation.title).toBe("");
  });
});
