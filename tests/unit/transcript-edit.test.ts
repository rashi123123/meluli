/* @vitest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";
import { applyTranscriptEdit } from "@main/services/transcript-edit.service";
import { buildTranscriptSrt } from "@main/services/subtitle-export.service";
import { transcriptUpdateSchema } from "@shared/schemas";
import { getTranscriptCues } from "@shared/transcript-cues";
import type { TranscriptRecord } from "@shared/types";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
const openDatabase = () => {
  const dir = mkdtempSync(join(tmpdir(), "ivrit-menu-bar-test-"));
  tempDirs.push(dir);
  return createAppDatabase(dir);
};

const words: TranscriptRecord = {
  id: "words", createdAt: 1, sourceType: "microphone", backend: "nemo",
  text: "שלום עולם. שוב.", paragraphs: ["שלום עולם. שוב."],
  segments: [{ start: 0.2, end: 0.5, text: "שלום" }, { start: 0.55, end: 1.2, text: "אמ" }, { start: 1.3, end: 1.6, text: "עולם" }, { start: 3, end: 3.4, text: "שוב" }]
};

describe("transcript editing", () => {
  it("keeps cue timings, and the reading text as clean as a new transcript", () => {
    const content = applyTranscriptEdit(words, { cueTexts: ["שלום אמ עולם גדול", "שוב"] }, { removeFillerWords: true });
    expect(content.segments).toEqual([{ start: 0.2, end: 1.6, text: "שלום אמ עולם גדול" }, { start: 3, end: 3.4, text: "שוב" }]);
    expect(content.text).toContain("שלום עולם גדול");
    expect(content.text).not.toContain("אמ ");
    expect(content.paragraphs?.length).toBeGreaterThan(0);
  });

  it("drops a cleared cue but refuses to empty a transcript or mismatch its cues", () => {
    expect(applyTranscriptEdit(words, { cueTexts: ["שלום", " "] }, { removeFillerWords: false }).segments).toHaveLength(1);
    expect(() => applyTranscriptEdit(words, { cueTexts: ["", " "] }, { removeFillerWords: false })).toThrow();
    expect(() => applyTranscriptEdit(words, { cueTexts: ["רק אחד"] }, { removeFillerWords: false })).toThrow();
    expect(() => applyTranscriptEdit(words, { text: "טקסט חופשי" }, { removeFillerWords: false })).toThrow();
  });

  it("takes free text as typed when there are no timings", () => {
    const plain: TranscriptRecord = { id: "plain", createdAt: 1, sourceType: "microphone", text: "ישן", paragraphs: ["ישן"] };
    expect(applyTranscriptEdit(plain, { text: "חדש" }, { removeFillerWords: true })).toEqual({ text: "חדש", paragraphs: null, segments: null });
  });

  it("exports the edited cues as they were saved", () => {
    const content = applyTranscriptEdit(words, { cueTexts: ["שלום עולם גדול", "שוב"] }, { removeFillerWords: true });
    const edited = { ...words, ...content, editedAt: 2 };
    expect(getTranscriptCues(edited)).toHaveLength(2);
    expect(buildTranscriptSrt(edited)).toBe("1\n00:00:00,200 --> 00:00:01,600\nשלום עולם גדול\n\n2\n00:00:03,000 --> 00:00:03,400\nשוב");
  });

  it("persists an edit, stays searchable, and restores the first original", () => {
    const { transcriptRepository: repository } = openDatabase();
    repository.create(words);
    const first = repository.update("words", { text: "גרסה ראשונה", paragraphs: null, segments: words.segments });
    expect(first?.editedAt).toBeGreaterThan(0);
    expect(first?.paragraphs).toBeNull();
    repository.update("words", { text: "גרסה שנייה", paragraphs: null, segments: words.segments });
    expect(repository.search("שנייה", 10).items.map(item => item.id)).toEqual(["words"]);

    const restored = repository.restoreOriginal("words");
    expect(restored?.text).toBe(words.text);
    expect(restored?.paragraphs).toEqual(words.paragraphs);
    expect(restored?.segments).toEqual(words.segments);
    expect(restored?.editedAt).toBeNull();
    expect(repository.search("שנייה", 10).items).toHaveLength(0);
  });

  it("leaves unknown or unedited transcripts alone", () => {
    const { transcriptRepository: repository } = openDatabase();
    repository.create(words);
    expect(repository.update("missing", { text: "x", paragraphs: null, segments: null })).toBeNull();
    expect(repository.restoreOriginal("missing")).toBeNull();
    expect(repository.restoreOriginal("words")?.text).toBe(words.text);
  });

  it("accepts exactly one kind of edit at the IPC boundary", () => {
    expect(transcriptUpdateSchema.safeParse({ id: "a", text: " טקסט " }).data).toEqual({ id: "a", text: "טקסט" });
    expect(transcriptUpdateSchema.safeParse({ id: "a", cueTexts: ["א"] }).success).toBe(true);
    expect(transcriptUpdateSchema.safeParse({ id: "a", text: "   " }).success).toBe(false);
    expect(transcriptUpdateSchema.safeParse({ id: "a", text: "א", cueTexts: ["א"] }).success).toBe(false);
    expect(transcriptUpdateSchema.safeParse({ id: "a", cueTexts: [{ start: 0, end: 1, text: "א" }] }).success).toBe(false);
  });
});
