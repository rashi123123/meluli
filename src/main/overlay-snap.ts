/**
 * Corner snapping for the overlay HUD. Uses screen.getDisplayMatching(bounds).workArea
 * so the window snaps within the visible area (avoids menu bar and dock). Preview state
 * is sent via IPC; snap and animation run in the main process.
 */
import { type BrowserWindow, screen, systemPreferences } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { OverlaySnapCorner } from "@shared/types";

const SNAP_MARGIN = 12;
const SNAP_THRESHOLD_PX = 100;
const DRAG_END_DEBOUNCE_MS = 200;
const ANIMATION_DURATION_MS = 280;
const ANIMATION_FRAME_MS = 16;

interface CornerTarget {
  corner: OverlaySnapCorner;
  x: number;
  y: number;
}

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

function computeCornerTargets(
  workArea: Electron.Rectangle,
  windowWidth: number,
  windowHeight: number
): CornerTarget[] {
  return [
    {
      corner: "top-left",
      x: workArea.x + SNAP_MARGIN,
      y: workArea.y + SNAP_MARGIN
    },
    {
      corner: "top-right",
      x: workArea.x + workArea.width - windowWidth - SNAP_MARGIN,
      y: workArea.y + SNAP_MARGIN
    },
    {
      corner: "bottom-left",
      x: workArea.x + SNAP_MARGIN,
      y: workArea.y + workArea.height - windowHeight - SNAP_MARGIN
    },
    {
      corner: "bottom-right",
      x: workArea.x + workArea.width - windowWidth - SNAP_MARGIN,
      y: workArea.y + workArea.height - windowHeight - SNAP_MARGIN
    }
  ];
}

function distanceToTarget(bounds: Electron.Rectangle, target: CornerTarget): number {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const tx = target.x + bounds.width / 2;
  const ty = target.y + bounds.height / 2;
  return Math.hypot(cx - tx, cy - ty);
}

function findNearestCorner(
  bounds: Electron.Rectangle,
  targets: CornerTarget[]
): { target: CornerTarget; distance: number } {
  let nearest = targets[0];
  let minDist = distanceToTarget(bounds, nearest);

  for (let i = 1; i < targets.length; i++) {
    const target = targets[i];
    const dist = distanceToTarget(bounds, target);
    if (dist < minDist) {
      minDist = dist;
      nearest = target;
    }
  }

  return { target: nearest, distance: minDist };
}

export function attachOverlaySnap(window: BrowserWindow): () => void {
  let dragEndTimer: ReturnType<typeof setTimeout> | null = null;
  let animationTimer: ReturnType<typeof setInterval> | null = null;
  let lastPreviewCorner: OverlaySnapCorner | null = null;
  let disposed = false;
  let isAnimating = false;

  function sendPreview(corner: OverlaySnapCorner | null): void {
    if (disposed || window.isDestroyed() || !window.isVisible()) {
      return;
    }

    if (corner === lastPreviewCorner) {
      return;
    }

    lastPreviewCorner = corner;
    window.webContents.send(IPC_CHANNELS.overlaySnapPreview, corner);
  }

  function cancelAnimation(): void {
    if (animationTimer !== null) {
      clearInterval(animationTimer);
      animationTimer = null;
    }
  }

  function animateToPosition(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ): void {
    cancelAnimation();

    const dx = toX - fromX;
    const dy = toY - fromY;

    if (systemPreferences.getAnimationSettings().prefersReducedMotion || (Math.abs(dx) < 2 && Math.abs(dy) < 2)) {
      isAnimating = true;
      window.setPosition(Math.round(toX), Math.round(toY), false);
      isAnimating = false;
      sendPreview(null);
      return;
    }

    isAnimating = true;
    const startTime = Date.now();

    animationTimer = setInterval(() => {
      if (disposed || window.isDestroyed() || !window.isVisible()) {
        cancelAnimation();
        isAnimating = false;
        return;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / ANIMATION_DURATION_MS, 1);
      const eased = easeOutQuart(progress);

      const x = Math.round(fromX + dx * eased);
      const y = Math.round(fromY + dy * eased);
      window.setPosition(x, y, false);

      if (progress >= 1) {
        cancelAnimation();
        isAnimating = false;
        sendPreview(null);
      }
    }, ANIMATION_FRAME_MS);
  }

  function onMoved(): void {
    if (disposed || window.isDestroyed() || !window.isVisible() || isAnimating) {
      return;
    }

    if (dragEndTimer !== null) {
      clearTimeout(dragEndTimer);
    }

    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const targets = computeCornerTargets(display.workArea, bounds.width, bounds.height);
    const { target: nearest, distance } = findNearestCorner(bounds, targets);
    const nearCorner = distance <= SNAP_THRESHOLD_PX;
    sendPreview(nearCorner ? nearest.corner : null);

    dragEndTimer = setTimeout(() => {
      dragEndTimer = null;
      if (disposed || window.isDestroyed() || !window.isVisible()) {
        return;
      }

      const currentBounds = window.getBounds();
      const currentDisplay = screen.getDisplayMatching(currentBounds);
      const snapTargets = computeCornerTargets(currentDisplay.workArea, currentBounds.width, currentBounds.height);
      const { target: snapTarget, distance: snapDistance } = findNearestCorner(currentBounds, snapTargets);

      if (snapDistance <= SNAP_THRESHOLD_PX) {
        animateToPosition(currentBounds.x, currentBounds.y, snapTarget.x, snapTarget.y);
      } else {
        sendPreview(null);
      }
    }, DRAG_END_DEBOUNCE_MS);
  }

  const stopMotion = () => {
    if (dragEndTimer !== null) clearTimeout(dragEndTimer);
    dragEndTimer = null;
    cancelAnimation();
    isAnimating = false;
    lastPreviewCorner = null;
  };
  const reposition = () => {
    stopMotion();
    if (!window.isDestroyed()) {
      const bounds = window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const x = Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)));
      const y = Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)));
      window.setPosition(Math.round(x), Math.round(y), false);
    }
  };
  window.on("moved", onMoved);
  window.on("hide", stopMotion);
  window.on("will-move", stopMotion);
  screen.on("display-removed", reposition);
  screen.on("display-metrics-changed", reposition);

  return () => {
    disposed = true;
    window.removeListener("moved", onMoved);
    window.removeListener("hide", stopMotion);
    window.removeListener("will-move", stopMotion);
    screen.removeListener("display-removed", reposition);
    screen.removeListener("display-metrics-changed", reposition);

    if (dragEndTimer !== null) {
      clearTimeout(dragEndTimer);
      dragEndTimer = null;
    }

    cancelAnimation();
  };
}
