/* @vitest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("TranscriptRepository", () => {
  it("creates, lists, searches, and deletes transcript rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivrit-menu-bar-test-"));
    tempDirs.push(dir);
    const database = createAppDatabase(dir);

    database.transcriptRepository.create({
      id: "1",
      createdAt: 3,
      sourceType: "microphone",
      text: "שלום עולם",
      rawText: "שלום עולם",
      paragraphs: ["שלום עולם."],
      importedFileName: null,
      possibleTerms: ["OpenAI"],
      uncertainSegments: ["שלום123"],
      durationMs: 5000,
      backend: "ct2",
      modelId: "demo"
    });
    database.transcriptRepository.create({
      id: "2",
      createdAt: 4,
      sourceType: "imported_file",
      text: "בדיקת חיפוש",
      rawText: "בדיקת חיפוש",
      paragraphs: ["בדיקת חיפוש."],
      importedFileName: "demo.wav",
      possibleTerms: [],
      uncertainSegments: [],
      durationMs: 2000,
      backend: "ct2",
      modelId: "demo"
    });
    database.transcriptRepository.create({
      id: "3",
      createdAt: 5,
      sourceType: "youtube",
      text: "תמלול מתוך סרטון",
      rawText: "תמלול מתוך סרטון",
      paragraphs: ["תמלול מתוך סרטון."],
      importedFileName: null,
      sourceTitle: "כותרת יוטיוב",
      sourceUrl: "https://www.youtube.com/watch?v=abc123xyz",
      possibleTerms: ["GPT-5"],
      uncertainSegments: ["מותג123"],
      durationMs: 6000,
      backend: "whispercpp",
      modelId: "demo",
      language: "he",
      segments: [
        { start: 0, end: 1.2, text: "תמלול" },
        { start: 1.2, end: 2.6, text: "מתוך סרטון" }
      ]
    });

    const listed = database.transcriptRepository.list(10);
    expect(listed.items).toHaveLength(3);
    expect(listed.items[0]?.id).toBe("3");

    const searched = database.transcriptRepository.search("חיפוש", 10);
    expect(searched.items).toHaveLength(1);
    expect(searched.items[0]?.id).toBe("2");

    const youtubeTitleSearch = database.transcriptRepository.search("כותרת", 10);
    expect(youtubeTitleSearch.items).toHaveLength(1);
    expect(youtubeTitleSearch.items[0]?.id).toBe("3");
    expect(youtubeTitleSearch.items[0]?.backend).toBe("whispercpp");
    expect(youtubeTitleSearch.items[0]?.possibleTerms).toEqual(["GPT-5"]);
    expect(youtubeTitleSearch.items[0]?.language).toBe("he");
    expect(youtubeTitleSearch.items[0]?.segments).toEqual([
      { start: 0, end: 1.2, text: "תמלול" },
      { start: 1.2, end: 2.6, text: "מתוך סרטון" }
    ]);

    const possibleTermsSearch = database.transcriptRepository.search("GPT-5", 10);
    expect(possibleTermsSearch.items).toHaveLength(1);
    expect(possibleTermsSearch.items[0]?.id).toBe("3");

    expect(database.transcriptRepository.delete("1")).toBe(true);
    expect(database.transcriptRepository.getById("1")).toBeNull();
  });
});
