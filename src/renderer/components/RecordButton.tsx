import type { ReactNode, Ref } from "react";
import { Microphone, Pause, Play, Stop, X } from "@/components/icons";
import { he } from "@shared/locale";
import { Button } from "./ui/button";

export type RecordButtonMode = "start" | "pause" | "resume" | "stop" | "cancel";

const modes = {
  start: { label: he.startRecording, text: "הקלטה", icon: Microphone, className: "capsule-go" },
  pause: { label: he.pauseRecording, text: "השהיה", icon: Pause, className: "capsule-round" },
  resume: { label: he.resumeRecording, text: "המשך", icon: Play, className: "capsule-round" },
  stop: { label: he.stopRecording, text: "עצירה", icon: Stop, className: "capsule-stop" },
  cancel: { label: he.processingCancel, text: "ביטול", icon: X, className: "capsule-cancel" }
};

/** A transport control. It only makes sense inside a .capsule. */
export function RecordButton({ mode, onClick, disabled = false, className = "", label: labelOverride, keyShortcuts, children, ref }: {
  mode: RecordButtonMode; onClick: () => void; disabled?: boolean; className?: string; label?: string; keyShortcuts?: string; children?: ReactNode; ref?: Ref<HTMLButtonElement>;
}) {
  const { label: modeLabel, text, icon: Icon, className: modeClass } = modes[mode];
  const label = labelOverride ?? modeLabel;
  const round = modeClass === "capsule-round";
  return <Button ref={ref} type="button" variant="plain" onClick={onClick} disabled={disabled} focusableWhenDisabled aria-label={label} aria-keyshortcuts={keyShortcuts} title={label} className={`${modeClass} ${className}`}>
    <Icon />{!round && <span>{text}</span>}{children}
  </Button>;
}
