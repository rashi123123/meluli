import { useEffect } from "react";

// Input origin is an event fact. :focus-visible alone can stay true when a
// pointer presses a button that already received keyboard focus.
export function usePointerFeedback() {
  useEffect(() => {
    const buttonFor = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLButtonElement>("button") : null;
    const pointer = (event: PointerEvent) => {
      if (document.documentElement.dataset.motionInput !== "pointer") document.documentElement.dataset.motionInput = "pointer";
      const button = buttonFor(event.target);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") button.dataset.pointerPress = "true";
    };
    const keyboard = (event: KeyboardEvent) => {
      if (document.documentElement.dataset.motionInput !== "keyboard") document.documentElement.dataset.motionInput = "keyboard";
      const button = buttonFor(event.target);
      if (button) delete button.dataset.pointerPress;
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      delete document.documentElement.dataset.motionInput;
    };
  }, []);
}
