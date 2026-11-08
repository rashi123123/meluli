import { useEffect, useId, useRef } from "react";
import type { CSSProperties } from "react";
import { motionSettings } from "@/components/motion";
import { he } from "@shared/locale";
import type { OverlayPosition } from "@shared/types";

const CAPSULE_MOVE_MS = 420;

type Spot = { position: Exclude<OverlayPosition, "last">; x: 0 | 1 | 2; y: 0 | 1 | 2 };

// The picker is a picture of the screen, so left and right stay physical in RTL.
const SPOTS: Spot[] = [
  { position: "top-left", x: 0, y: 0 }, { position: "top", x: 1, y: 0 }, { position: "top-right", x: 2, y: 0 },
  { position: "left", x: 0, y: 1 }, { position: "right", x: 2, y: 1 },
  { position: "bottom-left", x: 0, y: 2 }, { position: "bottom", x: 1, y: 2 }, { position: "bottom-right", x: 2, y: 2 }
];

const STEPS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** The spot one step away on the screen picture, jumping over the empty centre. */
function neighbour(from: Spot, [dx, dy]: [number, number]): Spot | undefined {
  for (let x = from.x + dx, y = from.y + dy; x >= 0 && x <= 2 && y >= 0 && y <= 2; x += dx, y += dy) {
    const spot = SPOTS.find(candidate => candidate.x === x && candidate.y === y);
    if (spot) return spot;
  }
  return undefined;
}

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
    const motion = motionSettings();
    if (!from || !current || from === current || motion.reduced) return;
    const stretch = Math.abs(current.x - from.x) >= Math.abs(current.y - from.y) ? "1.4 .78" : ".82 1.3";
    capsule.current?.animate?.([{ scale: "1 1" }, { scale: stretch, offset: .3 }, { scale: "1 1" }], { duration: CAPSULE_MOVE_MS, easing: motion.easing });
  }, [current]);
  return <div className="hud-picker" role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}>
    <div className="hud-screen" dir="ltr" onKeyDown={(event) => {
      const step = STEPS[event.key];
      const from = SPOTS.find(spot => spot.position === (event.target as HTMLInputElement).value);
      if (!step || !from) return;
      // Native radios walk the list in order; the picture needs up to mean up.
      event.preventDefault();
      const next = neighbour(from, step);
      if (!next) return;
      onChange(next.position);
      event.currentTarget.querySelector<HTMLInputElement>(`input[value="${next.position}"]`)?.focus();
    }}>
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
