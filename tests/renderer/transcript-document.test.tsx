import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "@/context/app-context";
import { TranscriptDocument } from "@/features/transcript/TranscriptDocument";
import { he } from "@shared/locale";
import type { TranscriptRecord } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root, updateTranscript: ReturnType<typeof vi.fn>, restoreTranscript: ReturnType<typeof vi.fn>, setErrorMessage: ReturnType<typeof vi.fn>;

const plain: TranscriptRecord = { id: "plain", text: "תמלול לבדיקה", createdAt: 1000, sourceType: "microphone" };
const timed: TranscriptRecord = {
  ...plain, id: "timed", text: "שורה ראשונה. שורה שנייה.",
  segments: [{ start: 0, end: 1, text: "שורה ראשונה." }, { start: 1, end: 2, text: "שורה שנייה." }]
};

const render = async (node: ReactNode) => {
  const context = { transcripts: { updateTranscript, restoreTranscript }, setErrorMessage } as unknown as AppContextValue;
  await act(async () => root.render(<AppContext.Provider value={context}>{node}</AppContext.Provider>));
};
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!;
const fields = () => [...host.querySelectorAll<HTMLTextAreaElement>("textarea")];
const click = async (name: string) => { await act(async () => button(name).click()); };
const type = async (field: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
};

beforeEach(() => {
  updateTranscript = vi.fn().mockResolvedValue({}); restoreTranscript = vi.fn().mockResolvedValue({}); setErrorMessage = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Object.assign(window, { ivritMenuBar: { files: { exportTranscriptSrt: vi.fn(), openExternal: vi.fn() } } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("transcript editing in place", () => {
  it("edits untimed text as one field and returns focus after saving", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה");
    expect(document.activeElement).toBe(fields()[0]);
    await type(fields()[0]!, "טקסט מתוקן");
    await click(he.save);
    expect(updateTranscript).toHaveBeenCalledWith("plain", { text: "טקסט מתוקן" });
    expect(fields()).toHaveLength(0);
    expect(document.activeElement).toBe(button("עריכה"));
  });

  it("edits timed transcripts line by line so subtitles keep their timing", async () => {
    await render(<TranscriptDocument transcript={timed} />);
    await click("עריכה");
    expect(fields()).toHaveLength(2);
    await type(fields()[1]!, "שורה מתוקנת.");
    await press("s", { metaKey: true });
    expect(updateTranscript).toHaveBeenCalledWith("timed", { cueTexts: ["שורה ראשונה.", "שורה מתוקנת."] });
  });

  it("leaves without a write when nothing changed", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה"); await press("Escape");
    expect(fields()).toHaveLength(0); expect(updateTranscript).not.toHaveBeenCalled();
    await click("עריכה"); await click(he.save);
    expect(fields()).toHaveLength(0); expect(updateTranscript).not.toHaveBeenCalled();
  });

  it("does not discard corrections on a single stray Escape", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה"); await type(fields()[0]!, "טקסט מתוקן");
    await press("Escape");
    expect(fields()[0]?.value).toBe("טקסט מתוקן");
    expect(document.activeElement).toBe(button(he.reset));
    await press("Escape");
    expect(fields()).toHaveLength(0); expect(updateTranscript).not.toHaveBeenCalled();
  });

  it("refuses to save an empty transcript and says why", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה"); await type(fields()[0]!, "   ");
    await click(he.save);
    expect(updateTranscript).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("אי אפשר לשמור תמלול ריק.");
  });

  it("keeps the text open when saving fails", async () => {
    updateTranscript.mockRejectedValue(new Error("disk full"));
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה"); await type(fields()[0]!, "טקסט מתוקן");
    await click(he.save);
    expect(setErrorMessage).toHaveBeenCalledWith("השינויים לא נשמרו. אפשר לנסות שוב.");
    expect(fields()[0]?.value).toBe("טקסט מתוקן");
  });

  it("saves pending corrections when the screen goes away, and only once", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה"); await type(fields()[0]!, "טקסט מתוקן");
    await act(async () => root.render(<div />));
    expect(updateTranscript).toHaveBeenCalledOnce();
    expect(updateTranscript).toHaveBeenCalledWith("plain", { text: "טקסט מתוקן" });
  });
});

describe("restoring the original", () => {
  const edited: TranscriptRecord = { ...plain, editedAt: 2000 };

  it("is offered only for an edited transcript", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    expect(button("שחזור המקור")).toBeUndefined();
    await render(<TranscriptDocument transcript={edited} />);
    expect(button("שחזור המקור")).toBeTruthy(); expect(host.textContent).toContain("נערך");
  });

  it("asks first, focuses the safe choice and can be dismissed with Escape", async () => {
    await render(<TranscriptDocument transcript={edited} />);
    await click("שחזור המקור");
    expect(document.activeElement).toBe(button(he.reset));
    await press("Escape");
    expect(host.querySelector(".inline-confirm")).toBeNull();
    expect(restoreTranscript).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("עריכה"));
  });

  it("restores on confirmation and reports a failure", async () => {
    await render(<TranscriptDocument transcript={edited} />);
    await click("שחזור המקור"); await click("שחזור");
    expect(restoreTranscript).toHaveBeenCalledWith("plain");
    expect(host.querySelector(".inline-confirm")).toBeNull();
    restoreTranscript.mockRejectedValue(new Error("db locked"));
    await click("שחזור המקור"); await click("שחזור");
    expect(setErrorMessage).toHaveBeenCalledWith("השחזור לא הושלם. אפשר לנסות שוב.");
    expect(host.querySelector(".inline-confirm")).toBeTruthy();
  });
});
