import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Select } from "@/components/ui/select";
import { useMicrophoneDevices } from "@/hooks/use-microphone-devices";
import { he } from "@shared/locale";
import type { MicrophonePermissionStatus } from "@shared/types";
import { OnboardingStepShell } from "./OnboardingStepShell";
import { SPEECH_BARS } from "./SpeechDemo";
import { PanelSweep } from "@/components/milestone-sweep";
import { isMicrophoneBlocked } from "@/lib/microphone-permission";
import type { MicrophoneCheckStatus } from "@/hooks/use-microphone-check";

/** How long the check listens before it suggests another microphone. */
const SILENT_HINT_MS = 6000;

type CheckStatus = MicrophoneCheckStatus;
export function MicrophoneStep({ permissionStatus, status = "idle", level = 0, error = null, deviceId = null, onSelectDevice, unavailable = false, actions }: {
  permissionStatus: MicrophonePermissionStatus; status?: CheckStatus; level?: number; error?: string | null; deviceId?: string | null; onSelectDevice?: (deviceId: string | null) => void; unavailable?: boolean; actions?: ReactNode;
}) {
  const live = status === "listening" || status === "detected";
  const detected = status === "detected";
  const denied = isMicrophoneBlocked(permissionStatus);
  const { devices, loaded } = useMicrophoneDevices(deviceId, live ? "live" : permissionStatus);
  // Labels and ids are known only with permission, and only once the system has answered;
  // before that every saved id would look missing.
  const missing = Boolean(deviceId) && permissionStatus === "granted" && loaded && !devices.some(device => device.deviceId === deviceId);
  // A check that hears nothing for a while says so, instead of waiting quietly forever.
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    setSilent(false);
    if (status !== "listening") return;
    const timer = window.setTimeout(() => setSilent(true), SILENT_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [status, deviceId]);
  // An error has its own line below, so the status line stays empty rather than saying it twice.
  const message = unavailable ? he.onboardingMicrophoneBusy
    : detected ? he.onboardingMicrophoneWorks
    : live ? silent ? he.onboardingMicrophoneSilent : he.onboardingMicrophoneListening
    : status === "requesting" ? permissionStatus === "not-determined" ? he.onboardingMicrophoneAsking : he.onboardingMicrophoneOpening
    : error ? null
    : permissionStatus === "granted" ? he.onboardingMicrophoneGranted
    : denied ? he.microphoneDenied : he.permissionNeeded;
  return <OnboardingStepShell stepLabel={he.stepMicrophone} title={he.onboardingMicrophoneTitle} description={he.onboardingMicrophoneBody} actions={actions}>
    <div className={`onboarding-microphone setup-panel ${live ? "is-live" : ""} ${detected ? "is-detected" : ""} ${live && !detected ? "state-recording" : ""}`} data-tone={detected ? "ok" : !live && (error || denied) ? "alert" : undefined}>
      <PanelSweep done={detected}><div className="demo-stage">
        <p className="microphone-feedback" role="status" data-empty={!message || undefined}>{message && <><span className="led" data-tone={detected ? "ok" : live ? "live" : undefined} />{message}</>}</p>
        <div className="microphone-level" role="meter" aria-label={he.onboardingMicrophoneLevel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
          {SPEECH_BARS.map((bar, index) => <span key={index} style={{ "--bar-level": bar } as CSSProperties} data-lit={live && level * SPEECH_BARS.length > index} />)}
        </div>
        {error && <p className="microphone-error" role="alert">{error}</p>}
        {/* A saved microphone that is gone stays listed, so choosing the system one is still a change. */}
        {(devices.length > 1 || missing) && onSelectDevice && <Select aria-label={he.microphoneInput} value={deviceId ?? ""} onChange={(event) => onSelectDevice(event.target.value || null)}>
          {missing && <option value={deviceId ?? ""}>{he.microphoneUnavailable}</option>}
          <option value="">{he.systemMicrophone}</option>
          {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </Select>}
      </div></PanelSweep>
    </div>
  </OnboardingStepShell>;
}
