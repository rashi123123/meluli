import { useEffect, useId, useRef } from "react";
import type { CSSProperties } from "react";
import { motionSettings } from "@/components/motion";
import { he } from "@shared/locale";
import type { OverlayPosition } from "@shared/types";

type Spot = { position: Exclude<OverlayPosition, "last">; x: 0 | 1 | 2; y: 0 | 1 | 2 };

// The picker is a picture of the screen, so left and right stay physical in RTL.
const SPOTS: Spot[] = [
  { position: "top-left", x: 0, y: 0 }, { position: "top", x: 1, y: 0 }, { position: "top-right", x: 2, y: 0 },
  { position: "left", x: 0, y: 1 }, { position: "right", x: 2, y: 1 },
  { position: "bottom-left", x: 0, y: 2 }, { position: "bottom", x: 1, y: 2 }, { position: "bottom-right", x: 2, y: 2 }
];

function anchor(x: number, y: number): CSSProperties {
  return { "--x": x / 2, "--y": y / 2 } as CSSProperties;
}

export function OverlayPositionPicker({ value, labelledBy, describedBy, onChange }: {
  value: OverlayPosition;
  labelledBy: string;
  describedBy: string;
  onChange: (position: OverlayPosition) => void;
}) {
  const name = useId();
  const current = SPOTS.find(spot => spot.position === value);
  const capsule = useRef<HTMLSpanElement>(null);
  const previous = useRef(current);
  // The capsule stretches along the way it travels, then settles.
  useEffect(() => {
    const from = previous.current;
    previous.current = current;
    if (!from || !current || from === current || motionSettings().reduced) return;
    const stretch = Math.abs(current.x - from.x) >= Math.abs(current.y - from.y) ? "1.4 .78" : ".82 1.3";
    capsule.current?.animate?.([{ scale: "1 1" }, { scale: stretch, offset: .3 }, { scale: "1 1" }], { duration: 420, easing: "cubic-bezier(.23, 1, .32, 1)" });
  }, [current]);
  return <div className="hud-picker" role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}>
    <div className="hud-screen" dir="ltr">
      {SPOTS.map(({ position, x, y }) => <label key={position} className="hud-spot" style={{ ...anchor(x, y), gridColumn: x + 1, gridRow: y + 1 }} title={he.overlayPositions[position]}>
        <input type="radio" name={name} value={position} checked={value === position} aria-label={he.overlayPositions[position]} onChange={() => onChange(position)} />
        <span aria-hidden="true" />
      </label>)}
      <span ref={capsule} className="hud-capsule" data-shown={current ? "true" : undefined} style={current ? anchor(current.x, current.y) : undefined} aria-hidden="true" />
    </div>
    <label className="hud-last" data-checked={value === "last" ? "true" : undefined}>
      <input type="radio" name={name} value="last" checked={value === "last"} onChange={() => onChange("last")} />
      <span>{he.overlayPositions.last}</span>
    </label>
  </div>;
}
