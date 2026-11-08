import { Microphone, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { formatShortcut } from "@/lib/shortcut";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";

/** The last step of setup: how dictation works from any app, and where the text lands. */
export function FirstTranscriptGuide() {
  const { settings, accessibilityPermissionStatus, requestAccessibilityPermission, dismissOnboardingOptionalAction, setErrorMessage } = useAppContext();
  if (!settings) return null;
  const pasteAllowed = accessibilityPermissionStatus === "granted";
  const allowPaste = () => requestAccessibilityPermission().catch((error: unknown) => setErrorMessage(getHebrewErrorMessage(error, he.genericError)));
  return <section className="workspace-setup-status" aria-label={he.onboardingFirstTranscriptTitle}>
    <Microphone />
    <div className="workspace-setup-copy">
      <strong>{he.onboardingFirstTranscriptTitle}</strong>
      <p>{he.onboardingFirstTranscriptLead} <kbd dir="ltr">{formatShortcut(settings.shortcut)}</kbd> {pasteAllowed ? he.onboardingFirstTranscriptBody : he.onboardingFirstTranscriptBodyNoPaste}</p>
    </div>
    <div className="workspace-setup-actions">
      {!pasteAllowed && <Button variant="secondary" size="sm" onClick={() => void allowPaste()}>{he.allowAccessibility}</Button>}
      <Button variant="ghost" size="icon-xs" aria-label={he.onboardingCloseGuide} title={he.onboardingCloseGuide} onClick={() => void dismissOnboardingOptionalAction("recording_shortcut")}><X /></Button>
    </div>
  </section>;
}
