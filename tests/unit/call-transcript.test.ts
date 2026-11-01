import { describe, expect, it } from "vitest";
import { formatCallText, formatCallTime, groupTurns, mergeTracks, textSimilarity } from "../../src/main/services/calls/call-transcript";

const line = (start: number, end: number, text: string) => ({ start, end, text });

describe("mergeTracks", () => {
  it("orders both speakers by time", () => {
    const merged = mergeTracks([line(5, 6, "אני עונה")], [line(1, 2, "מישהו שואל")]);
    expect(merged.map((segment) => segment.speaker)).toEqual(["others", "me"]);
  });

  it("drops the speakers' sound heard by the microphone", () => {
    const merged = mergeTracks([line(1.1, 2.9, "מה שלומכם היום חברים")], [line(1, 3, "מה שלומכם היום, חברים")]);
    expect(merged.map((segment) => segment.speaker)).toEqual(["others"]);
  });

  it("keeps the user's own words when they overlap someone else", () => {
    const merged = mergeTracks([line(1, 3, "רגע, יש לי שאלה")], [line(1, 3, "המחיר עלה השבוע")]);
    expect(merged).toHaveLength(2);
  });

  it("keeps the same sentence said later", () => {
    const merged = mergeTracks([line(60, 62, "אפשר להתחיל")], [line(1, 3, "אפשר להתחיל")]);
    expect(merged).toHaveLength(2);
  });
});

describe("text", () => {
  it("scores similar and different text", () => {
    expect(textSimilarity("שלום לכולם", "שלום לכולם!")).toBe(1);
    expect(textSimilarity("שלום לכולם", "המחיר עלה")).toBeLessThan(0.2);
    expect(textSimilarity("", "")).toBe(0);
  });

  it("formats call time", () => {
    expect(formatCallTime(72)).toBe("01:12");
    expect(formatCallTime(3_723)).toBe("1:02:03");
  });

  it("groups one speaker's lines into a turn", () => {
    const turns = groupTurns([
      { ...line(0, 2, "שלום"), speaker: "me" },
      { ...line(3, 4, "מה נשמע"), speaker: "me" },
      { ...line(5, 6, "טוב"), speaker: "others" },
      { ...line(40, 41, "ושוב"), speaker: "others" }
    ]);
    expect(turns.map((turn) => turn.text)).toEqual(["שלום מה נשמע", "טוב", "ושוב"]);
  });

  it("labels each turn and cleans it alone", () => {
    const { text, paragraphs } = formatCallText([
      { ...line(12, 13, "שלום"), speaker: "me" },
      { ...line(14, 15, "היי"), speaker: "others" }
    ], (value) => `${value}.`);
    expect(text).toBe("[00:12] אני: שלום.\n\n[00:14] משתתפים: היי.");
    expect(paragraphs).toHaveLength(2);
  });
});
