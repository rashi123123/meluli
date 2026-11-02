import type {
  AppSettings,
  MicrophonePermissionStatus,
  ModelDownloadState,
  OnboardingOptionalAction,
  OnboardingPhase,
  OnboardingState,
  OnboardingStepKey,
  OnboardingTrackingEvent,
  OnboardingTrackingMetrics,
  OnboardingTrackingState
} from "./types";

export const MAX_ONBOARDING_TRACKING_EVENTS = 200;

const BLOCKER_STEPS = new Set<OnboardingStepKey>(["microphone", "local_install"]);

export function getOnboardingStepKey(phase: OnboardingPhase): OnboardingStepKey {
  switch (phase) {
    case "not_started":
      return "ready";
    case "needs_mic":
      return "microphone";
    case "needs_hold_key":
      return "hold_key";
    case "needs_model":
      return "local_install";
    case "needs_first_transcript":
      return "first_transcript";
    case "activated":
      return "celebration";
  }
}

export function getOnboardingProgressIndex(step: OnboardingStepKey): number {
  switch (step) {
    case "ready":
      return 1;
    case "microphone":
      return 2;
    case "hold_key":
    case "local_install":
    case "first_transcript":
    case "celebration":
      return 3;
  }
}

const PHASE_ORDER: Record<OnboardingPhase, number> = {
  not_started: 0,
  needs_mic: 1,
  needs_hold_key: 2,
  needs_model: 3,
  needs_first_transcript: 4,
  activated: 5
};

export function resolveOnboardingPhase(input: {
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

export function resolveOnboardingSurface(input: Pick<OnboardingState, "surface"> & { phase: OnboardingPhase }) {
  if (input.phase === "activated" || input.phase === "needs_first_transcript") {
    return "workspace" as const;
  }

  return input.surface;
}

export function getPendingOnboardingOptionalActions(_onboarding: OnboardingState): OnboardingOptionalAction[] {
  return [];
}

export function appendOnboardingTrackingEvent(
  tracking: OnboardingTrackingState,
  event: OnboardingTrackingEvent
): OnboardingTrackingState {
  return {
    events: [...tracking.events, event].slice(-MAX_ONBOARDING_TRACKING_EVENTS)
  };
}

export function buildOnboardingTrackingMetrics(tracking: OnboardingTrackingState): OnboardingTrackingMetrics {
  const started = tracking.events.find((event) => event.name === "onboarding_started") ?? null;
  const micCompleted = tracking.events.find(
    (event) => event.name === "onboarding_step_completed" && event.step === "microphone"
  ) ?? null;
  const modelCompleted = tracking.events.find(
    (event) => event.name === "onboarding_step_completed" && event.step === "local_install"
  ) ?? null;
  const firstTranscriptStarted = tracking.events.find(
    (event) => event.name === "first_transcript_started" && event.sourceType === "microphone"
  ) ?? null;
  const firstTranscriptCompleted = tracking.events.find(
    (event) => event.name === "first_transcript_completed" && event.sourceType === "microphone"
  ) ?? null;
  const blockerViews = tracking.events.filter(
    (event) => event.name === "onboarding_step_viewed" && event.step && BLOCKER_STEPS.has(event.step)
  ).length;
  const blockerExits = tracking.events.filter(
    (event) => event.name === "onboarding_step_exited" && event.step && BLOCKER_STEPS.has(event.step)
  ).length;

  return {
    onboardingStartedAt: started?.occurredAt ?? null,
    microphonePermissionGrantRate: micCompleted ? 1 : 0,
    modelInstallCompletionRate: modelCompleted ? 1 : 0,
    medianTimeToFirstTranscriptMs:
      started && firstTranscriptCompleted ? firstTranscriptCompleted.occurredAt - started.occurredAt : null,
    firstTranscriptCompletionRate: firstTranscriptCompleted ? 1 : 0,
    firstTranscriptStartedAt: firstTranscriptStarted?.occurredAt ?? null,
    firstTranscriptCompletedAt: firstTranscriptCompleted?.occurredAt ?? null,
    blockerExitCount: blockerExits,
    blockerExitRate: blockerViews > 0 ? blockerExits / blockerViews : 0,
    optionalStepUptake: {
      recording_shortcut: buildOptionalActionStatus(tracking, "recording_shortcut"),
      overlay_accessibility: buildOptionalActionStatus(tracking, "overlay_accessibility")
    }
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
  const pendingOptionalActions = getPendingOnboardingOptionalActions(settings.onboarding);
  const activated = phase === "activated";

  return {
    phase,
    surface,
    step,
    progressIndex: getOnboardingProgressIndex(step),
    activated,
    showFlow: !activated && surface === "flow",
    showWorkspaceGuidance: !activated && surface === "workspace",
    showCelebration: activated && pendingOptionalActions.length > 0,
    pendingOptionalActions
  };
}

function buildOptionalActionStatus(
  tracking: OnboardingTrackingState,
  optionalAction: OnboardingOptionalAction
) {
  const completed = tracking.events.some(
    (event) => event.name === "optional_step_completed" && event.optionalAction === optionalAction
  );
  const dismissed = tracking.events.some(
    (event) => event.name === "optional_step_dismissed" && event.optionalAction === optionalAction
  );

  return {
    completed,
    dismissed,
    status: completed ? "completed" : dismissed ? "dismissed" : "pending"
  } as const;
}
