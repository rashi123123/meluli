/* @vitest-environment node */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ENTRIES, NOT_PREFIXED } from "@main/services/term-lexicon";
import { applyTerms, termMatcherForSettings } from "@main/services/term-replacement";
import { enhanceTranscript } from "@main/services/transcript-enhancer.service";
import { applyTranscriptEdit } from "@main/services/transcript-edit.service";
import type { TranscriptRecord } from "@shared/types";

const corpus = JSON.parse(readFileSync("benchmarks/corpus.json", "utf8")) as { samples: { reference: string }[] };
const hebrewReferences = corpus.samples.map((sample) => sample.reference).filter((text) => !/[A-Za-z]/u.test(text));
const matcher = termMatcherForSettings({ builtInTerms: true, dictionary: [] });

describe("built-in terms", () => {
  it("covers the broad list the launch needs", () => {
    expect(new Set(BUILT_IN_ENTRIES.map((entry) => entry.written)).size).toBeGreaterThanOrEqual(300);
  });

  it("gives every spelling one meaning", () => {
    const spellings = BUILT_IN_ENTRIES.map((entry) => entry.heard);
    expect(spellings.filter((heard, index) => spellings.indexOf(heard) !== index)).toEqual([]);
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

  it("can be turned off without losing the personal dictionary", () => {
    const personal = termMatcherForSettings({
      builtInTerms: false,
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
