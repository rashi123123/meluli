import { useId, type ReactNode } from "react";

const ring = { cx: 631, cy: 537, rx: 402, ry: 126, pathLength: 100, strokeDasharray: "50 19 5 7 3 7 2 7", fill: "none", strokeLinecap: "round" } as const;
const box = { x: 200, width: 870 };

// One colour throughout: the front of the ring cuts the object instead of being drawn over it.
export function OrbitGlyph({ top, height, tilt = -14, ringClassName, children }: { top: number; height: number; tilt?: number; ringClassName: string; children: ReactNode }) {
  const uid = useId().replace(/\W/g, "");
  const front = `${uid}front`, cut = `${uid}cut`, turn = `rotate(${tilt} 631 537)`;
  return <svg viewBox={`${box.x} ${top} ${box.width} ${height}`} aria-hidden="true">
    <defs>
      <clipPath id={front}><rect x="100" y="537" width="1062" height="400" /></clipPath>
      <mask id={cut} maskUnits="userSpaceOnUse" {...box} y={top} height={height}>
        <rect {...box} y={top} height={height} fill="#fff" />
        <g transform={turn} clipPath={`url(#${front})`}><ellipse {...ring} className={ringClassName} stroke="#000" strokeWidth="104" /></g>
      </mask>
    </defs>
    <g fill="currentColor" mask={`url(#${cut})`}>{children}</g>
    <ellipse {...ring} className={ringClassName} transform={turn} stroke="currentColor" strokeWidth="64" />
  </svg>;
}
