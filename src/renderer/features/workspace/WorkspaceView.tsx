import { useEffect, useRef, useState } from "react";
import { Warning } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { FirstTranscriptGuide } from "@/features/onboarding/FirstTranscriptGuide";
import { OnboardingWorkspaceCard } from "@/features/onboarding/OnboardingWorkspaceCard";
import { TranscriptDocument } from "@/features/transcript/TranscriptDocument";
import { he } from "@shared/locale";
import { CallStatus } from "./CallStatus";
import { RecordingArea } from "./RecordingArea";
import { RecentTranscripts } from "./RecentTranscripts";
import { isMicrophoneBlocked } from "@/lib/microphone-permission";

export function WorkspaceView() {
  const { lastTranscript, onboarding, settings, permissionStatus, trackOnboardingStepViewed, resumeOnboardingFlow } = useAppContext();
  const previousModelState = useRef(settings?.modelState.downloadState);
  const [modelReadyMessage, setModelReadyMessage] = useState("");
  useEffect(() => {
    const state = settings?.modelState.downloadState;
    if (previousModelState.current === "downloading" && state === "ready") setModelReadyMessage("מנוע התמלול מוכן. אפשר להתחיל להקליט.");
    else if (state !== "ready") setModelReadyMessage("");
    previousModelState.current = state;
  }, [settings?.modelState.downloadState]);
  const lastTrackedStepRef = useRef<string | null>(null);
  const newestSeenAt = useRef(Math.max(Date.now(), lastTranscript?.createdAt ?? 0));
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    // Going by status would miss a job that ends before "processing" renders.
    if (!lastTranscript || lastTranscript.createdAt <= newestSeenAt.current) return;
    newestSeenAt.current = lastTranscript.createdAt;
    setShowLatest(true);
  }, [lastTranscript]);
  const showWorkspaceGuidance = Boolean(onboarding?.showWorkspaceGuidance && onboarding.phase !== "needs_first_transcript");
  // After activation the same card recovers a model that went missing, instead of a dead Start button.
  const modelLost = Boolean(onboarding?.activated && settings && settings.modelState.downloadState !== "ready");
  const workspaceOnboarding = showWorkspaceGuidance || modelLost ? onboarding : null;
  const showFirstTranscriptGuide = onboarding?.phase === "needs_first_transcript" && onboarding.showWorkspaceGuidance
    && !settings?.onboarding.dismissedOptionalActions.includes("recording_shortcut");
  const microphoneBlocked = Boolean(onboarding?.activated) && isMicrophoneBlocked(permissionStatus);

  useEffect(() => {
    const stepToTrack = showWorkspaceGuidance ? onboarding?.step : null;
    if (!stepToTrack || lastTrackedStepRef.current === stepToTrack) return;
    lastTrackedStepRef.current = stepToTrack;
    void trackOnboardingStepViewed(stepToTrack);
  }, [onboarding, showWorkspaceGuidance, trackOnboardingStepViewed]);

  return <div className="workspace-stack">
    <p className="sr-only" role="status">{modelReadyMessage}</p>
    {workspaceOnboarding && <OnboardingWorkspaceCard phase={workspaceOnboarding.phase} onResumeSetup={() => void resumeOnboardingFlow()} />}
    {showFirstTranscriptGuide && <FirstTranscriptGuide />}
    {microphoneBlocked && <section className="workspace-setup-status" aria-label={he.microphoneBlockedTitle}>
      <Warning />
      <div className="workspace-setup-copy"><strong role="status">{he.microphoneBlockedTitle}</strong><p>{he.microphoneBlockedBody}</p></div>
      <Button variant="secondary" size="sm" onClick={() => void window.ivritMenuBar.permissions.openMicrophoneSettings()}>{he.openSystemSettings}</Button>
    </section>}
    <RecordingArea />
    {/* Call progress and failures sit under the recorder, so they never push the main control down. */}
    <CallStatus />
    {lastTranscript && showLatest && <div className="latest-result">
      <div className="transcript-tray"><TranscriptDocument key={lastTranscript.id} transcript={lastTranscript} onClose={() => setShowLatest(false)} /></div>
    </div>}
    <RecentTranscripts excludeId={lastTranscript && showLatest ? lastTranscript.id : undefined} />
  </div>;
}
