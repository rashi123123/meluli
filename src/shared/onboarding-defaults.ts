import type { OnboardingState, OnboardingTrackingState } from "./types";

export function createDefaultOnboardingState(activated = false): OnboardingState {
  return {
    phase: activated ? "activated" : "not_started",
    surface: activated ? "workspace" : "flow",
    activatedAt: null,
    completedOptionalActions: [],
    dismissedOptionalActions: []
  };
}

export function createDefaultOnboardingTrackingState(): OnboardingTrackingState {
  return {
    events: []
  };
}
