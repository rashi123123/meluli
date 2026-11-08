import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeToast } from "../../src/renderer/components/NoticeToast";
import { usePointerFeedback } from "../../src/renderer/components/usePointerFeedback";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();
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
