/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { appSettingsSchema } from "@shared/schemas";
import { deriveOnboardingDisplayState } from "@shared/onboarding";

describe("deriveOnboardingDisplayState", () => {
  it.each(["needs_mic", "needs_model"] as const)("finishing prerequisites from %s in the background does not invent activation", phase => {
    const settings = appSettingsSchema.parse({ onboarding: { phase, surface: "workspace" } });
    settings.modelState.downloadState = "ready";

    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({
      phase: "needs_first_transcript",
      surface: "workspace",
      activated: false,
      showFlow: false
    });
    expect(settings.onboarding.activatedAt).toBeNull();
    expect(settings.onboardingTracking.events).toHaveLength(0);
  });

  it("moves a profile stored on the old hold key step to the transcription engine", () => {
    const settings = appSettingsSchema.parse({ onboarding: { phase: "needs_hold_key", surface: "flow" } });
    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({ phase: "needs_model", step: "local_install", showFlow: true });
  });

  it("keeps the paste step in the flow while the engine is ready, and counts it as the last step", () => {
    const settings = appSettingsSchema.parse({ onboarding: { phase: "needs_paste", surface: "flow" } });
    settings.modelState.downloadState = "ready";
    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({ phase: "needs_paste", step: "paste", showFlow: true, progressIndex: 3 });
    const model = appSettingsSchema.parse({ onboarding: { phase: "needs_model", surface: "flow" } });
    expect(deriveOnboardingDisplayState(model, "granted")).toMatchObject({ step: "local_install", progressIndex: 3 });
  });

  it("resolves a paste step left on Home to whatever is still missing", () => {
    const settings = appSettingsSchema.parse({ onboarding: { phase: "needs_paste", surface: "workspace" } });
    settings.modelState.downloadState = "ready";
    expect(deriveOnboardingDisplayState(settings, "granted")).toMatchObject({ phase: "needs_first_transcript", showFlow: false });
  });

  it.each(["needs_mic", "needs_model"] as const)("keeps %s in the flow until explicit continuation even with ready prerequisites", phase => {
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
      showFlow: false
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
