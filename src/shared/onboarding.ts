import { MAX_ONBOARDING_TRACKING_EVENTS } from "./constants";
import type {
  AppSettings,
  MicrophonePermissionStatus,
  ModelDownloadState,
  OnboardingPhase,
  OnboardingState,
  OnboardingStepKey,
  OnboardingTrackingEvent,
  OnboardingTrackingState
} from "./types";


function getOnboardingStepKey(phase: OnboardingPhase): OnboardingStepKey {
  switch (phase) {
    case "not_started":
      return "ready";
    case "needs_mic":
      return "microphone";
    case "needs_hold_key":
      return "hold_key";
    case "needs_paste":
      return "paste";
    case "needs_model":
      return "local_install";
    case "needs_first_transcript":
      return "first_transcript";
    case "activated":
      return "celebration";
  }
}

function getOnboardingProgressIndex(step: OnboardingStepKey): number {
  switch (step) {
    case "ready":
      return 1;
    case "microphone":
      return 2;
    // The engine downloads in the background from the first step, so it is not a step of its own.
    case "paste":
    case "hold_key":
    case "local_install":
    case "first_transcript":
    case "celebration":
      return 3;
  }
}

// Paste sits between the microphone and the engine. Inside the flow an earlier phase is kept, so the
// paste step still shows while the engine downloads; on Home it resolves to whatever is still missing.
const PHASE_ORDER: Record<OnboardingPhase, number> = {
  not_started: 0,
  needs_mic: 1,
  needs_hold_key: 2,
  needs_paste: 2,
  needs_model: 3,
  needs_first_transcript: 4,
  activated: 5
};

function resolveOnboardingPhase(input: {
  currentPhase: OnboardingPhase;
  surface: OnboardingState["surface"];
  permissionStatus: MicrophonePermissionStatus;
  modelDownloadState: ModelDownloadState;
}): OnboardingPhase {
  if (input.currentPhase === "activated" || input.currentPhase === "not_started") {
    return input.currentPhase;
  }
  // A profile stored this phase while the hold key was a setup step. It lives in Settings now.
  const currentPhase = input.currentPhase === "needs_hold_key" ? "needs_model" : input.currentPhase;

  const naturalPhase: OnboardingPhase =
    input.permissionStatus !== "granted"
      ? "needs_mic"
      : input.modelDownloadState !== "ready"
        ? "needs_model"
        : "needs_first_transcript";

  if (
    input.surface === "flow" &&
    PHASE_ORDER[currentPhase] < PHASE_ORDER[naturalPhase]
  ) {
    return currentPhase;
  }

  return naturalPhase;
}

function resolveOnboardingSurface(input: Pick<OnboardingState, "surface"> & { phase: OnboardingPhase }) {
  if (input.phase === "activated" || input.phase === "needs_first_transcript") {
    return "workspace" as const;
  }

  return input.surface;
}

export function appendOnboardingTrackingEvent(
  tracking: OnboardingTrackingState,
  event: OnboardingTrackingEvent
): OnboardingTrackingState {
  return {
    events: [...tracking.events, event].slice(-MAX_ONBOARDING_TRACKING_EVENTS)
  };
}

export function deriveOnboardingDisplayState(
  settings: AppSettings,
  permissionStatus: MicrophonePermissionStatus
) {
  const phase = resolveOnboardingPhase({
    currentPhase: settings.onboarding.phase,
    surface: settings.onboarding.surface,
    permissionStatus,
    modelDownloadState: settings.modelState.downloadState
  });
  const surface = resolveOnboardingSurface({
    phase,
    surface: settings.onboarding.surface
  });
  const step = getOnboardingStepKey(phase);
  const activated = phase === "activated";

  return {
    phase,
    surface,
    step,
    progressIndex: getOnboardingProgressIndex(step),
    activated,
    showFlow: !activated && surface === "flow",
    showWorkspaceGuidance: !activated && surface === "workspace"
  };
}
