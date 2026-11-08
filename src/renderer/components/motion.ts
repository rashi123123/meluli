// Read the shared CSS vocabulary only at interaction time.
export function motionSettings() {
  const style = getComputedStyle(document.documentElement);
  return {
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    easing: style.getPropertyValue("--motion-ease-out").trim() || "cubic-bezier(0.23, 1, 0.32, 1)"
  };
}
