/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { appSettingsSchema } from "@shared/schemas";
import type { OnboardingTrackingState } from "@shared/types";
import {
  appendOnboardingTrackingEvent,
  buildOnboardingTrackingMetrics,
  deriveOnboardingDisplayState
} from "@shared/onboarding";

describe("deriveOnboardingDisplayState", () => {
  it.each(["needs_mic", "needs_model"] as const)("finishing prerequisites from %s in the background does not invent activation", phase => {
    const settings = appSettingsSchema.parse({ onboarding: { phase, surface: "workspace" } });
    settings.modelState.downloadState = "ready";

    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({
      phase: "needs_first_transcript",
      surface: "workspace",
      activated: false,
      showFlow: false,
      showCelebration: false
    });
    expect(settings.onboarding.activatedAt).toBeNull();
    expect(settings.onboardingTracking.events).toHaveLength(0);
  });

  it.each(["needs_mic", "needs_hold_key", "needs_model"] as const)("keeps %s in the flow until explicit continuation even with ready prerequisites", phase => {
    const settings = appSettingsSchema.parse({ onboarding: { phase, surface: "flow" } });
    settings.modelState.downloadState = "ready";

    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({
      phase,
      surface: "flow",
      activated: false,
      showFlow: true
    });
  });

  it("preserves existing activation when permissions or model availability change", () => {
    const settings = appSettingsSchema.parse({ onboarding: { phase: "activated", surface: "workspace", activatedAt: 100 } });
    settings.modelState.downloadState = "missing";

    expect(deriveOnboardingDisplayState(settings, "denied")).toMatchObject({
      phase: "activated",
      surface: "workspace",
      activated: true,
      showFlow: false,
      pendingOptionalActions: []
    });
    expect(settings.onboarding.activatedAt).toBe(100);
  });

  it("keeps the welcome state until the user advances past the intro", () => {
    const settings = appSettingsSchema.parse({});

    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({
      phase: "not_started",
      surface: "flow",
      step: "ready",
      showFlow: true
    });
  });

  it("keeps the first transcript step visible after mic and model are ready", () => {
    const settings = appSettingsSchema.parse({
      onboarding: {
        phase: "needs_first_transcript",
        surface: "workspace",
        activatedAt: null,
        completedOptionalActions: [],
        dismissedOptionalActions: []
      },
      modelState: {
        id: "demo",
        url: "https://example.com/model.bin",
        fileName: "model.bin",
        filePath: "/tmp/model.bin",
        downloadState: "ready",
        bytesDownloaded: 12,
        totalBytes: 12
      }
    });

    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({
      phase: "needs_first_transcript",
      surface: "workspace",
      step: "first_transcript",
      activated: false,
      showFlow: false,
      showWorkspaceGuidance: true
    });
  });

  it("moves a persisted first transcript flow state onto the workspace surface", () => {
    const settings = appSettingsSchema.parse({
      onboarding: {
        phase: "needs_first_transcript",
        surface: "flow",
        activatedAt: null,
        completedOptionalActions: [],
        dismissedOptionalActions: []
      },
      modelState: {
        id: "demo",
        url: "https://example.com/model.bin",
        fileName: "model.bin",
        filePath: "/tmp/model.bin",
        downloadState: "ready",
        bytesDownloaded: 12,
        totalBytes: 12
      }
    });

    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({
      phase: "needs_first_transcript",
      surface: "workspace",
      step: "first_transcript",
      activated: false,
      showFlow: false,
      showWorkspaceGuidance: true
    });
  });
});

describe("buildOnboardingTrackingMetrics", () => {
  it("derives completion and timing metrics from local onboarding events", () => {
    const tracking = [
      {
        name: "onboarding_started" as const,
        occurredAt: 100,
        phase: "not_started" as const,
        step: "ready" as const
      },
      {
        name: "onboarding_step_viewed" as const,
        occurredAt: 200,
        phase: "needs_mic" as const,
        step: "microphone" as const
      },
      {
        name: "onboarding_step_completed" as const,
        occurredAt: 400,
        phase: "needs_mic" as const,
        step: "microphone" as const
      },
      {
        name: "onboarding_step_completed" as const,
        occurredAt: 800,
        phase: "needs_model" as const,
        step: "local_install" as const
      },
      {
        name: "first_transcript_started" as const,
        occurredAt: 900,
        phase: "needs_first_transcript" as const,
        step: "first_transcript" as const,
        sourceType: "microphone" as const
      },
      {
        name: "first_transcript_completed" as const,
        occurredAt: 1300,
        phase: "activated" as const,
        step: "first_transcript" as const,
        sourceType: "microphone" as const
      },
      {
        name: "optional_step_dismissed" as const,
        occurredAt: 1500,
        phase: "activated" as const,
        step: "celebration" as const,
        optionalAction: "overlay_accessibility" as const
      }
    ].reduce(
      (state, event) =>
        appendOnboardingTrackingEvent(state, {
          optionalAction: null,
          sourceType: null,
          ...event
        }),
      { events: [] } as OnboardingTrackingState
    );

    expect(buildOnboardingTrackingMetrics(tracking)).toMatchObject({
      onboardingStartedAt: 100,
      microphonePermissionGrantRate: 1,
      modelInstallCompletionRate: 1,
      medianTimeToFirstTranscriptMs: 1200,
      firstTranscriptCompletionRate: 1,
      blockerExitCount: 0,
      optionalStepUptake: {
        overlay_accessibility: { status: "dismissed" },
        recording_shortcut: { status: "pending" }
      }
    });
  });
});
