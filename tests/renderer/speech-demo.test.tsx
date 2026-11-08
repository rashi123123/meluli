import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechDemo } from "@/features/onboarding/SpeechDemo";

let reducedMotion = false;
let mediaQuery: EventTarget;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const render = async () => { await act(async () => root.render(<SpeechDemo />)); };
const advance = async (duration: number) => { await act(async () => vi.advanceTimersByTime(duration)); };
const revealed = () => host.querySelectorAll('.demo-phrase[data-revealed="true"]').length;

beforeEach(() => {
  vi.useFakeTimers(); reducedMotion = false;
  mediaQuery = new EventTarget();
  vi.stubGlobal("matchMedia", () => mediaQuery);
  Object.defineProperty(mediaQuery, "matches", { configurable: true, get: () => reducedMotion });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("onboarding speech illustration", () => {
  it("plays once on entry and never starts again by itself", async () => {
    await render();
    expect(host.querySelector(".onboarding-demo")?.getAttribute("data-state")).toBe("playing");
    expect(revealed()).toBe(0);
    await advance(450); expect(revealed()).toBe(1);
    await advance(700); expect(revealed()).toBe(2);
    await advance(750); expect(revealed()).toBe(3);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
    await advance(1100);
    expect(host.querySelector(".onboarding-demo")?.getAttribute("data-state")).toBe("complete");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("משפט לדוגמה: מחר בתשע נפגשים לקפה. אשלח לך את הכתובת.");
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000); expect(vi.getTimerCount()).toBe(0);
    expect(host.querySelector(".onboarding-demo")?.getAttribute("data-state")).toBe("complete");
  });

  it("identifies an example and never touches the microphone", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    await render(); await advance(3000);
    expect(host.querySelector(".onboarding-demo")?.getAttribute("aria-label")).toBe("הדגמה של דיבור לטקסט");
    expect(host.querySelector("button")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each(["reduced motion", "hidden window"])("opens on the complete static example under %s", async condition => {
    reducedMotion = condition === "reduced motion";
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(condition === "hidden window");
    await render();
    expect(revealed()).toBe(3);
    expect(host.querySelector(".onboarding-demo")?.getAttribute("data-motion")).toBe("instant");
    expect(host.querySelector(".onboarding-demo")?.getAttribute("data-state")).toBe("complete");
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockRestore();
  });

  it("cancels all remaining timers on unmount", async () => {
    await render(); await advance(1000);
    expect(revealed()).toBe(1);
    await act(async () => root.render(<div />));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends an active sequence immediately if reduced motion is enabled", async () => {
    await render(); await advance(450);
    await act(async () => { reducedMotion = true; mediaQuery.dispatchEvent(new Event("change")); });
    expect(revealed()).toBe(3);
    expect(host.querySelector(".onboarding-demo")?.getAttribute("data-motion")).toBe("instant");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends an active sequence immediately when the window is hidden", async () => {
    await render(); await advance(450);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(revealed()).toBe(3); expect(vi.getTimerCount()).toBe(0);
    hidden.mockRestore();
  });
});
