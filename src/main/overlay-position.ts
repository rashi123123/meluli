import type { OverlayPosition } from "@shared/types";

interface Rectangle { x: number; y: number; width: number; height: number }

const OVERLAY_EDGE_MARGIN = 24;

/** Retain dragged position, but keep the HUD reachable after display changes. */
export function clampOverlayPosition(bounds: Rectangle, workArea: Rectangle): { x: number; y: number } {
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + Math.max(0, workArea.width - bounds.width)))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + Math.max(0, workArea.height - bounds.height))))
  };
}

/** Where a chosen preset puts the HUD on a display; the caller still clamps it. */
export function presetOverlayPosition(preset: Exclude<OverlayPosition, "last">, size: { width: number; height: number }, workArea: Rectangle): { x: number; y: number } {
  const end = { x: workArea.x + workArea.width - size.width - OVERLAY_EDGE_MARGIN, y: workArea.y + workArea.height - size.height - OVERLAY_EDGE_MARGIN };
  const center = { x: workArea.x + (workArea.width - size.width) / 2, y: workArea.y + (workArea.height - size.height) / 2 };
  const start = { x: workArea.x + OVERLAY_EDGE_MARGIN, y: workArea.y + OVERLAY_EDGE_MARGIN };
  return {
    x: preset.includes("left") ? start.x : preset.includes("right") ? end.x : center.x,
    y: preset.includes("top") ? start.y : preset.includes("bottom") ? end.y : center.y
  };
}
