/* @vitest-environment node */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOT_PREFIXED, TERM_PACK_ENTRIES, termMatcherForSettings } from "@main/services/text-rules/term-lexicon";
import { DEFAULT_TERM_PACKS, TERM_PACK_IDS } from "@shared/constants";
import { applyTerms } from "@main/services/text-rules/term-replacement";
import { enhanceTranscript } from "@main/services/text-rules/transcript-enhancer.service";
import { applyTranscriptEdit } from "@main/services/transcript-edit.service";
import type { TranscriptRecord } from "@shared/types";

const corpus = JSON.parse(readFileSync("benchmarks/corpus.json", "utf8")) as { samples: { reference: string }[] };
const hebrewReferences = corpus.samples.map((sample) => sample.reference).filter((text) => !/[A-Za-z]/u.test(text));
const ALL_ENTRIES = TERM_PACK_IDS.flatMap((id) => TERM_PACK_ENTRIES[id]);
// Every pack at once, so a collision in a pack that is off by default still fails here.
const matcher = termMatcherForSettings({ termPacks: [...TERM_PACK_IDS], dictionary: [] });
const written = (entries: readonly { written: string }[]) => new Set(entries.map((entry) => entry.written));

describe("built-in terms", () => {
  it("covers the broad list the launch needs by default", () => {
    expect(written(DEFAULT_TERM_PACKS.flatMap((id) => TERM_PACK_ENTRIES[id])).size).toBeGreaterThanOrEqual(300);
  });

  it("gives every pack its own terms", () => {
    for (const id of TERM_PACK_IDS) expect(written(TERM_PACK_ENTRIES[id]).size, id).toBeGreaterThanOrEqual(25);
  });

  it("gives every spelling one meaning, in every pack", () => {
    const meanings = new Map<string, Set<string>>();
    for (const entry of ALL_ENTRIES) meanings.set(entry.heard, (meanings.get(entry.heard) ?? new Set()).add(entry.written));
    expect([...meanings].filter(([, values]) => values.size > 1)).toEqual([]);
    for (const id of TERM_PACK_IDS) {
      const spellings = TERM_PACK_ENTRIES[id].map((entry) => entry.heard);
      expect(spellings.filter((heard, index) => spellings.indexOf(heard) !== index), id).toEqual([]);
    }
  });

  it("applies only the packs that are on", () => {
    const text = "פתחתי פול ריקווסט וקבעתי אוטו לייאאוט";
    const dev = termMatcherForSettings({ termPacks: ["dev"], dictionary: [] });
    const design = termMatcherForSettings({ termPacks: ["design"], dictionary: [] });
    expect(applyTerms(text, dev)).toBe("פתחתי pull request וקבעתי אוטו לייאאוט");
    expect(applyTerms(text, design)).toBe("פתחתי פול ריקווסט וקבעתי auto layout");
  });

  it("changes nothing in plain Hebrew speech", () => {
    expect(hebrewReferences.length).toBeGreaterThan(0);
    const changed = hebrewReferences.filter((text) => applyTerms(text, matcher) !== text);
    expect(changed).toEqual([]);
  });

  it("blocks every prefixed form that is a word in the corpus", () => {
    const vocabulary = new Set(hebrewReferences.flatMap((text) => text.match(/[\p{L}']+/gu) ?? []));
    const collisions = [...vocabulary].filter((word) => applyTerms(word, matcher) !== word);
    expect(collisions.filter((word) => !NOT_PREFIXED.includes(word))).toEqual([]);
  });

  it("keeps a term spelled with a doubled word through repeat removal", () => {
    const dictate = (text: string) => enhanceTranscript(text, { removeFillerWords: true, terms: matcher }).text;
    expect(dictate("יש איי איי בכל מקום")).toBe("יש AI בכל מקום.");
    expect(dictate("אל אל אם")).toBe("LLM.");
  });

  it("drops a stutter that only opens like a doubled term", () => {
    const dictate = (text: string) => enhanceTranscript(text, { removeFillerWords: true, terms: matcher }).text;
    expect(dictate("אל אל תדאג אני אטפל בזה")).toBe("אל תדאג אני אטפל בזה.");
    expect(dictate("טי טי זה לא עובד")).toBe("טי זה לא עובד.");
  });

  it("keeps a pack's prefixes for a word the personal dictionary also has", () => {
    const both = termMatcherForSettings({
      termPacks: [...DEFAULT_TERM_PACKS],
      dictionary: [
        { id: "1", heard: "סלאק", written: "Slack" }, { id: "2", heard: "גיט", written: "Git" },
        { id: "3", heard: "פיגמה", written: "Figma" }, { id: "4", heard: "דור", written: "Dor" }, { id: "5", heard: "תום", written: "Tom" }
      ]
    });
    expect(applyTerms("תבדוק בסלאק ובגיט", both)).toBe("תבדוק ב־Slack וב־Git");
    expect(applyTerms("תפתח את הפיגמה", both)).toBe("תפתח את ה־Figma");
    expect(applyTerms("הדור הצעיר נפגש בתום הישיבה", both)).toBe("הדור הצעיר נפגש בתום הישיבה");
  });

  it("does not read a blog as a log", () => {
    for (const text of ["כתבתי בבלוג שלי", "הבלוג שלי", "אני כותב לבלוג", "ובלוג חדש", "פרסמתי בלוגים", "קראתי את הבלוגים שלו"]) {
      expect(applyTerms(text, matcher)).toBe(text);
    }
  });

  it("can be turned off without losing the personal dictionary", () => {
    const personal = termMatcherForSettings({
      termPacks: [],
      dictionary: [{ id: "1", heard: "מלולי", written: "Meluli" }]
    });
    expect(applyTerms("מלולי וקלוד", personal)).toBe("Meluli וקלוד");
  });
});

describe("corrected cues", () => {
  const transcript = (segments: TranscriptRecord["segments"]) => ({ text: "", segments }) as TranscriptRecord;

  it("keeps a correction through a cue edit", () => {
    const edited = applyTranscriptEdit(
      transcript([{ start: 0, end: 1, text: "CLAUDE.md" }, { start: 1, end: 2, text: "שלום" }]),
      { cueTexts: ["קראתי את CLAUDE.md", "שלום"] },
      { removeFillerWords: false }
    );
    expect(edited.text).toContain("CLAUDE.md");
  });

  it("returns a term split across two cues to its raw form after an edit, as documented", () => {
    const edited = applyTranscriptEdit(
      transcript([{ start: 0, end: 1, text: "פתחתי פול" }, { start: 1, end: 2, text: "ריקווסט" }]),
      { cueTexts: ["פתחתי פול", "ריקווסט"] },
      { removeFillerWords: false }
    );
    expect(edited.text).toContain("פול ריקווסט");
    expect(enhanceTranscript("פתחתי פול ריקווסט", { removeFillerWords: false, terms: matcher }).text).toContain("pull request");
  });
});
