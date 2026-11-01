import { useCallback, useEffect, useRef, type MouseEvent, type SyntheticEvent } from "react";
import { motionSettings } from "./motion";

type Activation = { detail: number };

export function useMotionDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const animation = useRef<Animation | null>(null);
  const cancel = useCallback(() => {
    if (!animation.current) return;
    animation.current.onfinish = null;
    animation.current.cancel();
    animation.current = null;
  }, []);
  const reset = useCallback(() => {
    cancel();
    if (!ref.current) return;
    delete ref.current.dataset.motion;
    delete ref.current.dataset.motionPhase;
  }, [cancel]);
  const play = useCallback((frames: Keyframe[], duration: number, easing: string, finish: () => void) => {
    const dialog = ref.current;
    if (!dialog?.animate) { finish(); return; }
    const next = dialog.animate(frames, { duration, easing, fill: "both" });
    animation.current = next;
    next.onfinish = () => {
      if (animation.current !== next) return;
      animation.current = null;
      finish();
      next.cancel();
    };
  }, []);
  const open = useCallback((event?: Activation) => {
    const dialog = ref.current;
    if (!dialog) return;
    const current = dialog.open && animation.current ? getComputedStyle(dialog) : null;
    // Copy before cancelling; the computed style is a live object.
    const from = current ? { opacity: current.opacity, transform: current.transform } : null;
    cancel();
    const pointer = (event?.detail ?? 0) > 0;
    dialog.dataset.motion = pointer ? "pointer" : "instant";
    dialog.dataset.motionPhase = pointer ? "opening" : "open";
    if (!dialog.open) dialog.showModal();
    if (!pointer) return;
    const settings = motionSettings();
    play([
      { opacity: from?.opacity ?? 0, transform: settings.reduced ? "none" : from?.transform ?? "scale(.97)" },
      { opacity: 1, transform: "none" }
    ], settings.dialogIn, settings.easing, () => { dialog.dataset.motionPhase = "open"; });
  }, [cancel, play]);
  const close = useCallback((event?: Activation) => {
    const dialog = ref.current;
    if (!dialog?.open) { reset(); return; }
    const pointer = (event?.detail ?? 0) > 0;
    if (!pointer) { reset(); dialog.close(); return; }
    if (dialog.dataset.motionPhase === "closing") return;
    const current = getComputedStyle(dialog);
    const from = { opacity: current.opacity, transform: current.transform };
    cancel();
    dialog.dataset.motion = "pointer";
    dialog.dataset.motionPhase = "closing";
    const settings = motionSettings();
    play([
      { opacity: from.opacity, transform: settings.reduced ? "none" : from.transform },
      { opacity: 0, transform: settings.reduced ? "none" : "scale(.97)" }
    ], settings.dialogOut, settings.easing, () => { dialog.close(); });
  }, [cancel, play, reset]);
  const onCancel = useCallback((event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    close(); // Escape never waits for an entrance or exit animation.
  }, [close]);
  const onClose = useCallback(() => {
    // Native close events are queued; a new opening may already be in progress.
    if (!ref.current?.open) reset();
  }, [reset]);
  const onBackdropClick = useCallback((event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) close(event);
  }, [close]);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => { animation.current?.finish(); };
    preference.addEventListener("change", settle);
    return () => { preference.removeEventListener("change", settle); cancel(); };
  }, [cancel]);

  return { ref, open, close, onCancel, onClose, onBackdropClick };
}
