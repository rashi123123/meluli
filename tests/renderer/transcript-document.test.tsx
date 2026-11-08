import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "@/context/app-context";
import { TranscriptDocument } from "@/features/transcript/TranscriptDocument";
import { he } from "@shared/locale";
import type { TranscriptRecord } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root, updateTranscript: ReturnType<typeof vi.fn>, restoreTranscript: ReturnType<typeof vi.fn>, setErrorMessage: ReturnType<typeof vi.fn>, updateSetting: ReturnType<typeof vi.fn>;
let dictionary: Array<{ id: string; heard: string; written: string }> = [];

const plain: TranscriptRecord = { id: "plain", text: "תמלול לבדיקה", createdAt: 1000, sourceType: "microphone" };
const timed: TranscriptRecord = {
  ...plain, id: "timed", text: "שורה ראשונה. שורה שנייה.",
  segments: [{ start: 0, end: 1, text: "שורה ראשונה." }, { start: 1, end: 2, text: "שורה שנייה." }]
};

const render = async (node: ReactNode) => {
  const context = { transcripts: { updateTranscript, restoreTranscript }, setErrorMessage, settings: { dictionary }, updateSetting } as unknown as AppContextValue;
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
  dictionary = []; updateSetting = vi.fn().mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Object.assign(window, { ivritMenuBar: { files: { exportTranscript: vi.fn(), openExternal: vi.fn() } } });
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

  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  it("closes an untouched editor once the transcript was saved elsewhere", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה");
    await render(<TranscriptDocument transcript={{ ...plain, text: "תיקון חדש", editedAt: 2000 }} />);
    await settle();
    expect(fields()).toHaveLength(0);
    expect(updateTranscript).not.toHaveBeenCalled();
  });

  it("keeps a draft open when the transcript was saved elsewhere, says so, and never writes it on its own", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה"); await type(fields()[0]!, "טיוטה ישנה");
    await render(<TranscriptDocument transcript={{ ...plain, text: "תיקון חדש", editedAt: 2000 }} />);
    await settle();
    expect(fields()[0]?.value).toBe("טיוטה ישנה");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(he.transcriptChangedElsewhere);
    await act(async () => root.unmount()); root = createRoot(host);
    expect(updateTranscript).not.toHaveBeenCalled();
  });

  it("lets the person keep the draft over the newer text", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה"); await type(fields()[0]!, "טיוטה ישנה");
    await render(<TranscriptDocument transcript={{ ...plain, text: "תיקון חדש", editedAt: 2000 }} />);
    await settle();
    await click(he.save);
    expect(updateTranscript).toHaveBeenCalledWith("plain", { text: "טיוטה ישנה" });
    expect(fields()).toHaveLength(0);
  });

  it("does not take a missing edit time and a null one for a change elsewhere", async () => {
    await render(<TranscriptDocument transcript={plain} />);
    await click("עריכה");
    await render(<TranscriptDocument transcript={{ ...plain, editedAt: null }} />);
    await settle();
    expect(fields()).toHaveLength(1);
    await type(fields()[0]!, "טקסט מתוקן");
    await act(async () => root.unmount()); root = createRoot(host);
    expect(updateTranscript).toHaveBeenCalledWith("plain", { text: "טקסט מתוקן" });
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

describe("playing a kept recording", () => {
  let play: ReturnType<typeof vi.spyOn>;
  const withAudio = (bytes: Uint8Array | null) => {
    Object.assign(window, { ivritMenuBar: { files: { exportTranscript: vi.fn(), openExternal: vi.fn() }, recordings: { audio: vi.fn().mockResolvedValue(bytes) } } });
  };
  const cues = () => [...host.querySelectorAll<HTMLElement>(".transcript-cue")];
  const control = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play")); return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  });

  it("plays from the sentence that was clicked and marks it", async () => {
    withAudio(new Uint8Array(64));
    await render(<TranscriptDocument transcript={timed} recordingId="rec" />);
    expect(cues().map(cue => cue.textContent)).toEqual(["שורה ראשונה.", "שורה שנייה."]);
    expect(cues()[1]!.getAttribute("role")).toBe("button");
    await act(async () => cues()[1]!.click());
    expect(play).toHaveBeenCalled();
    expect(host.querySelector("audio")!.currentTime).toBe(1);
    expect(cues()[1]!.getAttribute("aria-current")).toBe("true");
    expect(control(he.playbackPause)).toBeTruthy();
  });

  it("plays and pauses with Space inside the player and keeps playing while editing", async () => {
    withAudio(new Uint8Array(64));
    await render(<TranscriptDocument transcript={timed} recordingId="rec" />);
    control(he.playbackPlay).focus();
    await press(" ");
    expect(play).toHaveBeenCalledTimes(1);
    await click("עריכה");
    expect(host.querySelector("audio")).toBeTruthy();
    expect(control(he.playbackPause)).toBeTruthy();
  });

  it("moves through the recording with the bar without starting it", async () => {
    withAudio(new Uint8Array(64));
    await render(<TranscriptDocument transcript={timed} recordingId="rec" />);
    const audio = host.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 2 });
    await act(async () => { audio.dispatchEvent(new Event("loadedmetadata")); });
    const bar = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(bar.getAttribute("aria-label")).toBe(he.playbackPosition);
    expect(bar.closest(".transcript-player")!.getAttribute("dir")).toBe("ltr");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(bar, "1.5");
      bar.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(audio.currentTime).toBe(1.5);
    expect(play).not.toHaveBeenCalled();
    expect(bar.getAttribute("aria-valuetext")).toBe(`00:01 ${he.playbackOf} 00:02`);
    expect(host.querySelector(".transcript-player")!.nextElementSibling).toBeNull();
    expect(host.querySelector(".transcript-player")!.previousElementSibling?.className).toBe("dictionary-suggestions");
  });

  it("says the recording is gone instead of offering a player", async () => {
    withAudio(null);
    await render(<TranscriptDocument transcript={timed} recordingId="rec" />);
    expect(host.textContent).toContain(he.recordingGone);
    expect(host.querySelector("audio")).toBeNull();
    expect(cues()).toHaveLength(0);
  });

  it("reads as plain text without a kept recording", async () => {
    withAudio(new Uint8Array(64));
    await render(<TranscriptDocument transcript={timed} />);
    expect(host.querySelector(".transcript-player")).toBeNull();
    expect(cues()).toHaveLength(0);
  });
});

describe("teaching the dictionary from a correction", () => {
  const status = () => host.querySelector<HTMLElement>(".dictionary-suggestions")!;
  const correct = async (from: TranscriptRecord, line: number, value: string) => {
    await render(<TranscriptDocument transcript={from} />);
    await click("עריכה"); await type(fields()[line]!, value); await click(he.save);
  };
  const spoken: TranscriptRecord = { ...timed, segments: [{ start: 0, end: 1, text: "כתבתי בריאקט היום." }, { start: 1, end: 2, text: "שורה שנייה." }] };

  it("asks quietly after a one-word fix and adds the pair", async () => {
    await correct(spoken, 0, "כתבתי בReact היום.");
    expect(status().getAttribute("role")).toBe("status");
    expect(status().textContent).toContain(`${he.suggestionAsk} "React" ${he.suggestionInsteadOf} "ריאקט"?`);
    button(he.suggestionAdd).focus(); await click(he.suggestionAdd);
    expect(updateSetting).toHaveBeenCalledWith("dictionary", [expect.objectContaining({ heard: "ריאקט", written: "React" })]);
    expect(status().textContent).toContain(he.suggestionAdded);
    expect(document.activeElement).toBe(button(he.reset));
    await click(he.reset);
    expect(updateSetting).toHaveBeenLastCalledWith("dictionary", []);
    expect(status().textContent).toBe("");
    expect(document.activeElement).toBe(button("עריכה"));
  });

  it("does not ask about a rewrite, a known pair, or a pair already declined", async () => {
    await correct(spoken, 0, "משהו שונה לגמרי במשפט הזה עכשיו.");
    expect(status().textContent).toBe("");
    dictionary = [{ id: "1", heard: "ריאקט", written: "React" }];
    await correct(spoken, 0, "כתבתי בReact היום.");
    expect(status().textContent).toBe("");
    dictionary = [];
    await correct(spoken, 0, "כתבתי בReact היום.");
    await click(he.suggestionDismiss);
    expect(status().textContent).toBe("");
    await click("עריכה"); await type(fields()[0]!, "כתבתי בReact היום!"); await click(he.save);
    expect(status().textContent).toBe("");
  });

  it("keeps the row and says so when the dictionary is not saved", async () => {
    updateSetting.mockRejectedValueOnce(new Error("disk"));
    await correct(spoken, 0, "כתבתי בReact היום.");
    await click(he.suggestionAdd);
    expect(status().textContent).toContain(he.suggestionFailed);
    expect(button(he.suggestionAdd)).toBeTruthy();
  });
});

describe("words that may be misheard", () => {
  const flagged: TranscriptRecord = { ...plain, id: "flagged", text: "פתחתי את גיטHub, ואז שמרתי.", uncertainSegments: ["גיטHub"] };
  const marks = () => [...host.querySelectorAll<HTMLElement>(".suspect-word")];

  it("underlines a flagged word, describes it, and opens the editor with it selected", async () => {
    await render(<TranscriptDocument transcript={flagged} />);
    expect(marks().map(mark => mark.textContent)).toEqual(["גיטHub"]);
    expect(marks()[0]!.getAttribute("aria-description")).toBe(he.suspectWord);
    expect(marks()[0]!.getAttribute("title")).toBe(he.suspectWordHint);
    expect(host.querySelector(".transcript-text")!.textContent).toBe(flagged.text);
    marks()[0]!.focus();
    await press("Enter");
    const field = fields()[0]!;
    expect(document.activeElement).toBe(field);
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("גיטHub");
  });

  it("stops flagging once the transcript has been corrected", async () => {
    await render(<TranscriptDocument transcript={{ ...flagged, editedAt: 2000 }} />);
    expect(marks()).toHaveLength(0);
  });
});

describe("flagged words inside a sentence that plays", () => {
  it("marks the word without making it a second control", async () => {
    Object.assign(window, { ivritMenuBar: { files: { exportTranscript: vi.fn(), openExternal: vi.fn() }, recordings: { audio: vi.fn().mockResolvedValue(new Uint8Array(64)) } } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    await render(<TranscriptDocument transcript={{ ...timed, uncertainSegments: ["ראשונה"] }} recordingId="rec" />);
    const mark = host.querySelector<HTMLElement>(".transcript-cue .suspect-word")!;
    expect(mark.textContent).toBe("ראשונה");
    expect(mark.getAttribute("role")).toBeNull();
    expect(mark.getAttribute("aria-description")).toBe(he.suspectWord);
  });
});
