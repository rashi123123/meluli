/* @vitest-environment node */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Each of these had no reader in any mode. A name that comes back should come back with one.
const REMOVED: [path: string, name: string][] = [
  ["src/renderer/context/overlay-app-provider.tsx", "does not support"],
  ["src/renderer/context/overlay-app-provider.tsx", "emptyTranscripts"],
  ["src/renderer/features/overlay/FloatingRecorderHud.tsx", "useAppContext"],
  ["src/main/ipc/register.ts", "parsed.pcm instanceof Float32Array ? parsed.pcm"],
  ["src/main/services/transcription.service.ts", 'type: "partial"'],
  ["src/main/services/transcription.service.ts", 'message.type === "partial"'],
  ["src/main/services/transcription.service.ts", '"ct2" || message.backend'],
  ["src/main/services/transcription.service.ts", "validateModelPath"],
  ["src/main/services/transcription.service.ts", "validatedModelPathCache"],
  ["src/renderer/context/app-context.tsx", "setRecordingShortcut"],
  ["src/renderer/context/app-context.tsx", "setOverlayShortcut"],
  ["src/renderer/context/app-context.tsx", "onboardingMetrics"],
  ["src/renderer/context/app-context.tsx", "completeOnboardingOptionalAction"],
  ["src/renderer/context/app-context.tsx", "isOwner"],
  ["src/renderer/context/main-app-provider.tsx", "completeOnboardingOptionalAction"],
  ["src/shared/ipc-channels.ts", "transcriptionProgress"],
  ["src/preload/index.ts", "transcriptionProgress"],
  ["src/shared/preload-api.ts", "progress: { stage: string }"],
  ["src/main/ipc/register.ts", "ensureTranscriptionProgressListener"],
  ["src/main/services/transcription-workflow.service.ts", "IPC_CHANNELS.transcriptionProgress"],
  ["src/shared/schemas.ts", "appStateSnapshotSchema"],
  ["src/shared/schemas.ts", "overlaySessionSchema"],
  ["src/shared/schemas.ts", "youtubeJobInfoSchema"],
  ["src/shared/schemas.ts", "workerVadModeSchema"],
  ["src/shared/schemas.ts", "transcriptListResultSchema"],
  ["src/shared/schemas.ts", "appErrorSchema"],
  ["src/shared/types.ts", "WhisperCppVadConfig"],
  ["src/shared/types.ts", "TranscriptionEventPayload"],
  ["src/shared/types.ts", "TranscriptionErrorPayload"],
  ["src/main/services/transcription-workflow.service.ts", "transcribeStandalone"],
  ["src/main/ipc/registry.ts", "logErrors"],
  ["src/main/services/container.ts", "onTranscriptionSettled"],
  ["src/renderer/context/overlay-app-provider.tsx", "settingsRef"],
  ["src/renderer/components/icons.tsx", "YoutubeLogo"],
  ["src/renderer/instrument.css", "--motion-notice-out"],
  ["src/renderer/context/main-app-provider.tsx", "useMemo<AppContextValue>"],
  ["src/renderer/context/overlay-app-provider.tsx", "useMemo<AppContextValue>"],
  ["src/shared/ipc-channels.ts", "model:status"],
  ["src/shared/ipc-channels.ts", "history:get"],
  ["src/shared/ipc-channels.ts", "shortcut:get"],
  ["src/shared/ipc-channels.ts", "shortcut:set"]
];

describe("removed code", () => {
  it("states the shared enums once, with no runtime import in the types file the preload reads", () => {
    const types = readFileSync("src/shared/types.ts", "utf8");
    for (const literal of ['"not_started"', '"recording_shortcut"', '"onboarding_started"', '"last" | "top"', '"workspace" | "history"']) expect(types).not.toContain(literal);
    expect(types).not.toMatch(/^import \{/mu);
  });

  it.each(REMOVED)("%s has no %s", (path, name) => {
    expect(readFileSync(path, "utf8")).not.toContain(name);
  });

  it("has no parallel shortcut decision table", () => {
    expect(existsSync("src/main/shortcut-hud.ts")).toBe(false);
  });
});
