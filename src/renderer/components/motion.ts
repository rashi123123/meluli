// Read the shared CSS vocabulary only at interaction time.
export function motionSettings() {
  const style = getComputedStyle(document.documentElement);
  const duration = (name: string, fallback: number) => Number.parseFloat(style.getPropertyValue(name)) || fallback;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gentle = duration("--motion-reduced", 120);
  return {
    reduced,
    easing: style.getPropertyValue("--motion-ease-out").trim() || "cubic-bezier(0.23, 1, 0.32, 1)",
    dialogIn: reduced ? gentle : duration("--motion-dialog-in", 200),
    dialogOut: reduced ? gentle : duration("--motion-dialog-out", 150)
  };
}
