import type { CSSProperties, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useMicrophoneDevices } from "@/hooks/use-microphone-devices";
import { he } from "@shared/locale";
import type { MicrophonePermissionStatus } from "@shared/types";
import { OnboardingStepShell } from "./OnboardingStepShell";
import { SPEECH_BARS } from "./SpeechDemo";

type CheckStatus = "idle" | "requesting" | "listening" | "detected" | "error";
export function MicrophoneStep({ permissionStatus, status = "idle", level = 0, error = null, deviceId = null, onSelectDevice, onStop, onOpenSettings, unavailable = false, actions }: {
  permissionStatus: MicrophonePermissionStatus; status?: CheckStatus; level?: number; error?: string | null; deviceId?: string | null; onSelectDevice?: (deviceId: string | null) => void; onStop?: () => void; onOpenSettings?: () => void; unavailable?: boolean; actions?: ReactNode;
}) {
  const live = status === "listening" || status === "detected";
  const detected = status === "detected";
  const denied = permissionStatus === "denied" || permissionStatus === "restricted";
  const { devices } = useMicrophoneDevices(deviceId, live ? "live" : permissionStatus);
  const message = unavailable ? "נסיים את ההקלטה או התמלול, ואז אפשר לבדוק." : detected ? "המיקרופון עובד" : live ? "אפשר להגיד כמה מילים" : status === "requesting" ? "פותחים את המיקרופון…" : error ? "ננסה שוב?" : permissionStatus === "granted" ? "המיקרופון מאושר. נבדוק ששומעים." : he.permissionNeeded;
  return <OnboardingStepShell stepLabel={he.stepMicrophone} title={he.onboardingMicrophoneTitle} description={he.onboardingMicrophoneBody} actions={actions}>
    <div className={`onboarding-microphone setup-panel ${live ? "is-live" : ""} ${detected ? "is-detected" : ""} ${live && !detected ? "state-recording" : ""}`} data-tone={detected ? "ok" : !live && (error || denied) ? "alert" : undefined}>
      <div className="demo-stage">
        <p className="microphone-feedback" role="status"><span className="led" data-tone={detected ? "ok" : live ? "live" : undefined} />{message}</p>
        <div className="microphone-level" role="meter" aria-label="עוצמת המיקרופון" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
          {SPEECH_BARS.map((bar, index) => <span key={index} style={{ "--bar-level": bar } as CSSProperties} data-lit={live && level * SPEECH_BARS.length > index} />)}
        </div>
        {error && <p className="microphone-error" role="alert">{error}</p>}
        {denied && onOpenSettings && <Button variant="secondary" size="sm" onClick={onOpenSettings}>פתיחת הגדרות המיקרופון</Button>}
        {devices.length > 1 && onSelectDevice && <Select aria-label={he.microphoneInput} value={deviceId ?? ""} onChange={(event) => onSelectDevice(event.target.value || null)}>
          <option value="">{he.systemMicrophone}</option>
          {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </Select>}
      </div>
      <div className="demo-transport">
        {live && onStop ? <Button variant="ghost" size="sm" data-motion="instant" onClick={onStop}>עצירת הבדיקה</Button> : <span>ללא שמירה או תמלול</span>}
      </div>
    </div>
  </OnboardingStepShell>;
}
