/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { applyTerms, buildTermMatcher, type TermEntry } from "@main/services/term-replacement";
import { enhanceTranscript } from "@main/services/transcript-enhancer.service";

const entries: TermEntry[] = [
  { heard: "קלוד אמדי", written: "CLAUDE.md" },
  { heard: "קלוד", written: "Claude" },
  { heard: "פול ריקווסט", written: "pull request" },
  { heard: "קומיט", written: "commit" },
  { heard: "לוג", written: "log" },
  { heard: "דוקר", written: "Docker" },
  { heard: "ירה", written: "yeah" },
  { heard: "ברנץ'", written: "branch" },
  { heard: "ג'ירה", written: "Jira" },
  { heard: "ריאקט", written: "ריאקט" },
  { heard: "Cloud", written: "Claude" },
  { heard: "גו", written: "Go" }
];
const matcher = buildTermMatcher({ entries, notPrefixed: ["מדוקר"] });
const replace = (text: string) => applyTerms(text, matcher);

describe("applyTerms", () => {
  it("prefers the longest phrase and never replaces inside a replacement", () => {
    expect(replace("תקרא את קלוד אמדי ואז את קלוד")).toBe("תקרא את CLAUDE.md ואז את Claude");

    const chained = buildTermMatcher({
      entries: [
        { heard: "קלוד", written: "גיט" },
        { heard: "גיט", written: "Git" }
      ]
    });
    expect(applyTerms("קלוד גיט", chained)).toBe("גיט Git");
  });

  it("keeps a Hebrew prefix and adds a maqaf before Latin", () => {
    expect(replace("עשיתי את הקומיט ובקומיט השני")).toBe("עשיתי את ה־commit וב־commit השני");
    expect(replace("פתחתי לקלוד")).toBe("פתחתי ל־Claude");
    expect(replace("בריאקט")).toBe("בריאקט");
  });

  it("does not strip a prefix from a word that stands on its own", () => {
    expect(replace("כתבתי בלוג חדש")).toBe("כתבתי ב־log חדש");

    const withWord = buildTermMatcher({ entries: [...entries, { heard: "בלוג", written: "blog" }] });
    expect(applyTerms("כתבתי בלוג חדש", withWord)).toBe("כתבתי blog חדש");

    const blocked = buildTermMatcher({ entries, notPrefixed: ["בלוג", "מדוקר"] });
    expect(applyTerms("כתבתי בלוג והוא מדוקר", blocked)).toBe("כתבתי בלוג והוא מדוקר");
  });

  it("requires three letters before accepting a prefix", () => {
    expect(replace("הגו את זה")).toBe("הגו את זה");
    expect(replace("גו")).toBe("Go");
  });

  it("treats a geresh as part of the word", () => {
    expect(replace("ברנץ' חדש")).toBe("branch חדש");
    expect(replace("פתחתי בג'ירה")).toBe("פתחתי ב־Jira");
    expect(replace("ג׳ירה")).toBe("Jira");
    expect(replace("צה\"ל")).toBe("צה\"ל");
  });

  it("does not touch a word that continues an identifier", () => {
    expect(replace("Cloud.md")).toBe("Cloud.md");
    expect(replace("קלוד/קוד")).toBe("קלוד/קוד");
    expect(replace("src/קלוד")).toBe("src/קלוד");
  });

  it("matches Latin without case and leaves other words alone", () => {
    expect(replace("cloud וגם CLOUD")).toBe("Claude וגם Claude");
    expect(replace("Cloudflare")).toBe("Cloudflare");
    expect(replace("קלודיה")).toBe("קלודיה");
  });

  it("matches a phrase across a space or a maqaf but not across punctuation", () => {
    expect(replace("פול  ריקווסט")).toBe("pull request");
    expect(replace("פול־ריקווסט")).toBe("pull request");
    expect(replace("פול. ריקווסט")).toBe("פול. ריקווסט");
    expect(replace("פול\nריקווסט")).toBe("פול\nריקווסט");
  });

  it("gives earlier entries priority", () => {
    const personal = buildTermMatcher({
      entries: [{ heard: "קלוד", written: "Klod" }, ...entries]
    });
    expect(applyTerms("קלוד", personal)).toBe("Klod");
  });

  it("does not interpret the written form", () => {
    const literal = buildTermMatcher({ entries: [{ heard: "כסף", written: "$& $1" }] });
    expect(applyTerms("כסף", literal)).toBe("$& $1");
  });

  it("returns the text unchanged with no terms, empty entries or niqqud", () => {
    const empty = buildTermMatcher({ entries: [{ heard: "  ", written: "x" }, { heard: "א", written: " " }] });
    expect(applyTerms("טקסט", empty)).toBe("טקסט");
    expect(replace("")).toBe("");
    expect(replace("קָלוֹד")).toBe("קָלוֹד");
  });

  it("handles 100K characters of Hebrew with a large list in under 50ms", () => {
    const large = buildTermMatcher({
      entries: Array.from({ length: 1500 }, (_, index) => ({ heard: `מונח${index} נוסף`, written: `term${index}` }))
    });
    const text = "זה משפט רגיל בעברית שחוזר על עצמו שוב ושוב ".repeat(2400);
    expect(text.length).toBeGreaterThan(100_000);

    const runs = Array.from({ length: 5 }, () => {
      const startedAt = performance.now();
      applyTerms(text, large);
      return performance.now() - startedAt;
    });
    expect(Math.min(...runs)).toBeLessThan(50);
  });
});

describe("enhanceTranscript with terms", () => {
  const options = { removeFillerWords: false, terms: matcher };

  it("corrects the clean text and keeps the raw text", () => {
    const result = enhanceTranscript("תפתח את קלוד אמדי ותעשה קומיט", options);
    expect(result.text).toContain("CLAUDE.md");
    expect(result.text).toContain("commit");
    expect(result.rawText).toBe("תפתח את קלוד אמדי ותעשה קומיט");
  });

  it("corrects a phrase before the sentence split can break it", () => {
    const before = Array.from({ length: 17 }, (_, index) => `מילה${index}`).join(" ");
    const result = enhanceTranscript(`${before} פול ריקווסט חדש`, options);
    expect(result.text).toContain("pull request");
    expect(result.text).not.toContain("\uE000");
  });

  it("keeps a prefixed dot file together", () => {
    const dotFile = buildTermMatcher({ entries: [{ heard: "דוט אנב", written: ".env" }] });
    const result = enhanceTranscript("כתוב בדוט אנב", { removeFillerWords: false, terms: dotFile });
    expect(result.text).toContain("ב־.env");
  });
});
