import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMotionDialog } from "../../src/renderer/components/useMotionDialog";
import { NoticeToast } from "../../src/renderer/components/NoticeToast";
import { usePointerFeedback } from "../../src/renderer/components/usePointerFeedback";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let controls: ReturnType<typeof useMotionDialog>;
let reduced = false;
const animations: { frames: Keyframe[]; options: KeyframeAnimationOptions; onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
function Probe() {
  controls = useMotionDialog();
  return <dialog ref={controls.ref} onCancel={controls.onCancel} onClose={controls.onClose} onClick={controls.onBackdropClick}><button>סגירה</button></dialog>;
}
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
beforeEach(() => {
  reduced = false; animations.length = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; queueMicrotask(() => this.dispatchEvent(new Event("close"))); } });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => {
    const entry = { frames, options, onfinish: null as (() => void) | null, cancel: vi.fn(), finish() { this.onfinish?.(); } };
    animations.push(entry); return entry;
  }) });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
  for (const [name, descriptor] of [["showModal", originalShow], ["close", originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

describe("native dialog motion lifecycle", () => {
  it("keeps keyboard open instant and Escape cancels a pending pointer entry", async () => {
    await render(<Probe />);
    await act(async () => controls.open({ detail: 0 }));
    expect(animations).toHaveLength(0); expect(controls.ref.current?.open).toBe(true);
    await act(async () => controls.close());
    await act(async () => controls.open({ detail: 1 }));
    expect(animations.at(-1)?.options.duration).toBe(200);
    await act(async () => controls.ref.current?.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(controls.ref.current?.open).toBe(false); expect(animations.at(-1)?.cancel).toHaveBeenCalled();
  });
  it("ignores an obsolete exit completion after the dialog is reopened", async () => {
    await render(<Probe />);
    await act(async () => controls.open());
    await act(async () => controls.close({ detail: 1 }));
    const obsoleteFinish = animations.at(-1)!.onfinish!;
    expect(animations.at(-1)?.options.duration).toBe(150);
    await act(async () => controls.open({ detail: 1 }));
    await act(async () => obsoleteFinish());
    expect(controls.ref.current?.open).toBe(true); expect(controls.ref.current?.dataset.motionPhase).toBe("opening");
  });
  it("does not let a queued native close event cancel a new entrance", async () => {
    await render(<Probe />);
    await act(async () => controls.open());
    await act(async () => { controls.close(); controls.open({ detail: 1 }); });
    expect(controls.ref.current?.open).toBe(true); expect(animations.at(-1)?.cancel).not.toHaveBeenCalled();
  });
  it("uses opacity-only 120ms motion for reduced motion", async () => {
    reduced = true; await render(<Probe />);
    await act(async () => controls.open({ detail: 1 }));
    expect(animations.at(-1)?.options.duration).toBe(120);
    expect(animations.at(-1)?.frames.every(frame => frame.transform === "none")).toBe(true);
    await act(async () => controls.close({ detail: 1 }));
    expect(animations.at(-1)?.options.duration).toBe(120);
    expect(animations.at(-1)?.frames.every(frame => frame.transform === "none")).toBe(true);
  });
  it("keeps interior padding clicks inside the dialog", async () => {
    await render(<Probe />); await act(async () => controls.open());
    const dialog = controls.ref.current!;
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
    await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 18, clientY: 18 })));
    expect(dialog.open).toBe(true); expect(animations).toHaveLength(0);
    await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 0, clientY: 0 })));
    expect(dialog.dataset.motionPhase).toBe("closing");
    await act(async () => animations.at(-1)?.finish()); expect(dialog.open).toBe(false);
  });
  it("cancels pending motion on unmount", async () => {
    await render(<Probe />); await act(async () => controls.open({ detail: 1 }));
    const entry = animations.at(-1)!;
    await render(<div />); expect(entry.cancel).toHaveBeenCalled(); expect(entry.onfinish).toBeNull();
  });
});

describe("notice presence", () => {
  const shown = () => [...host.querySelectorAll(".notice-toast > span")].map(item => item.textContent);
  it("stacks newer messages over the ones still standing", async () => {
    await render(<NoticeToast message="ראשונה" onDismiss={() => {}} />);
    await render(<NoticeToast message="שנייה" onDismiss={() => {}} />);
    expect(shown()).toEqual(["ראשונה", "שנייה"]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("שנייה");
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
  it("removes a message its owner cleared and keeps the rest", async () => {
    await render(<NoticeToast message="ראשונה" onDismiss={() => {}} />);
    await render(<NoticeToast message="שנייה" onDismiss={() => {}} />);
    await render(<NoticeToast message="" onDismiss={() => {}} />);
    expect(shown()).toEqual(["ראשונה"]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  });
  it("closes one message at a time and caps the stack", async () => {
    const onDismiss = vi.fn();
    for (const message of ["1", "2", "3", "4", "5"]) await render(<NoticeToast message={message} onDismiss={onDismiss} />);
    expect(shown()).toEqual(["2", "3", "4", "5"]);
    await act(async () => host.querySelector<HTMLButtonElement>(".notice-toast button")!.click());
    expect(shown()).toEqual(["3", "4", "5"]);
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".notice-toast button")].at(-1)!.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

function PointerProbe() { usePointerFeedback(); return <button className="primary-control">הקלטה</button>; }
it("tracks actual input origin and removes global listeners on unmount", async () => {
  await render(<PointerProbe />);
  const button = host.querySelector("button")!;
  button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(button.dataset.pointerPress).toBe("true");
  expect(document.documentElement.dataset.motionInput).toBe("pointer");
  button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
  expect(button.dataset.pointerPress).toBeUndefined();
  expect(document.documentElement.dataset.motionInput).toBe("keyboard");
  await render(<div />);
  expect(document.documentElement.dataset.motionInput).toBeUndefined();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(document.documentElement.dataset.motionInput).toBeUndefined();
});
