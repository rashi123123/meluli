/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { suggestDictionaryEntries } from "@shared/dictionary-suggestions";

const entry = (heard: string, written: string) => ({ id: heard, heard, written });

describe("dictionary suggestions from a correction", () => {
  it("offers a one-word swap and keeps a Hebrew prefix out of it", () => {
    expect(suggestDictionaryEntries(["אני כותב בריאקט כל יום."], ["אני כותב בReact כל יום."], [])).toEqual([{ heard: "ריאקט", written: "React" }]);
    expect(suggestDictionaryEntries(["פתחתי את הגיט האב"], ["פתחתי את GitHub"], [])).toEqual([{ heard: "הגיט האב", written: "GitHub" }]);
  });

  it("ignores punctuation, spacing, rewrites and emptied lines", () => {
    expect(suggestDictionaryEntries(["שלום, עולם"], ["שלום עולם."], [])).toEqual([]);
    expect(suggestDictionaryEntries(["זה משפט ארוך שהמשתמש כתב מחדש לגמרי"], ["משהו אחר לגמרי עם מילים חדשות לחלוטין"], [])).toEqual([]);
    expect(suggestDictionaryEntries(["אחת שתיים שלוש ארבע"], ["אחת"], [])).toEqual([]);
    expect(suggestDictionaryEntries(["שורה"], [""], [])).toEqual([]);
  });

  it("skips pairs the dictionary already has and stops at three", () => {
    expect(suggestDictionaryEntries(["כתבתי ריאקט"], ["כתבתי React"], [entry("ריאקט", "React")])).toEqual([]);
    expect(suggestDictionaryEntries(["כתבתי ריאקט"], ["כתבתי React"], [entry("ראקט", "React")])).toEqual([]);
    const lines = ["א ב1", "ג ד1", "ה ו1", "ז ח1"];
    expect(suggestDictionaryEntries(lines, lines.map(line => line.replace("1", "2")), [])).toHaveLength(3);
  });

  it("offers each pair once across lines", () => {
    expect(suggestDictionaryEntries(["ריאקט אחד", "ריאקט שתיים"], ["React אחד", "React שתיים"], [])).toEqual([{ heard: "ריאקט", written: "React" }]);
  });
});
