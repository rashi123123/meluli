/* @vitest-environment node */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  describe("search queries", () => {
    const open = () => {
      const dir = mkdtempSync(join(tmpdir(), "ivrit-menu-bar-test-"));
      tempDirs.push(dir);
      const repository = createAppDatabase(dir).transcriptRepository;
      repository.create({ id: "1", createdAt: 1, sourceType: "microphone", text: "alpha beta", rawText: "alpha beta", durationMs: 1, backend: "ct2", modelId: "demo" });
      return repository;
    };

    it("finds nothing, rather than failing, when no search term is left", () => {
      const repository = open();
      expect(repository.search("\"", 10)).toEqual({ items: [], nextCursor: null });
      expect(repository.search("' \"", 10)).toEqual({ items: [], nextCursor: null });
    });

    it("treats a NUL as a space", () => {
      expect(open().search("alpha\u0000beta", 10).items).toHaveLength(1);
    });

    it("searches for the start of a query past the token limit", () => {
      expect(open().search(`${"alpha ".repeat(16)}absent`, 10).items).toHaveLength(1);
    });

    it("searches for the start of a query past the length limit", () => {
      expect(open().search(`alpha${" ".repeat(2000)}absent`, 10).items).toHaveLength(1);
    });

    it("finds a word while it is still being typed", () => {
      expect(open().search("alp", 10).items).toHaveLength(1);
      expect(open().search("alp bet", 10).items).toHaveLength(1);
      expect(open().search("alp gam", 10).items).toHaveLength(0);
    });

    it("finds a Hebrew word under the letters written onto it", () => {
      const repository = open();
      repository.create({ id: "2", createdAt: 2, sourceType: "microphone", text: "נפגשנו בירושלים והבית היה מלא", rawText: "x", durationMs: 1, backend: "ct2", modelId: "demo" });
      expect(repository.search("ירוש", 10).items.map(item => item.id)).toEqual(["2"]);
      expect(repository.search("בית", 10).items.map(item => item.id)).toEqual(["2"]);
      expect(repository.search("בית ירושלים", 10).items.map(item => item.id)).toEqual(["2"]);
      expect(repository.search("בית תל", 10).items).toHaveLength(0);
      expect(repository.search(`${"בית ".repeat(64)}`, 10).items).toHaveLength(1);
    });
  });

  describe("search punctuation", () => {
    it("ignores a word with no letters in it, rather than finding nothing", () => {
      const dir = mkdtempSync(join(tmpdir(), "ivrit-menu-bar-test-"));
      tempDirs.push(dir);
      const repository = createAppDatabase(dir).transcriptRepository;
      repository.create({ id: "1", createdAt: 1, sourceType: "microphone", text: "alpha beta בית ספר", rawText: "x", durationMs: 1, backend: "ct2", modelId: "demo" });
      for (const query of ["alpha - beta", "alpha , beta", "alpha ? beta", "בית - ספר", "בית – ספר", "בית ־ ספר", "-"]) {
        expect(repository.search(query, 10).items.length, query).toBe(query === "-" ? 0 : 1);
      }
    });
  });

  describe("deleted text", () => {
    const onDisk = (dir: string, word: string) => readdirSync(dir)
      .filter((file) => file.includes(".sqlite"))
      .filter((file) => readFileSync(join(dir, file)).includes(word));
    const open = () => {
      const dir = mkdtempSync(join(tmpdir(), "ivrit-menu-bar-test-"));
      tempDirs.push(dir);
      const database = createAppDatabase(dir);
      const repository = database.transcriptRepository;
      const add = (id: string, text: string) => repository.create({ id, createdAt: 1, sourceType: "microphone", text, rawText: text, durationMs: 1, backend: "ct2", modelId: "demo" });
      return { dir, database, repository, add };
    };

    it("leaves no copy on disk, in the row or the search index, after one is deleted", () => {
      const { dir, repository, add } = open();
      add("kept", "Keptword stays");
      add("gone", "Secretword goes");
      expect(onDisk(dir, "Secretword")).not.toHaveLength(0);
      expect(onDisk(dir, "secretword")).not.toHaveLength(0);

      repository.delete("gone");

      expect(onDisk(dir, "Secretword")).toEqual([]);
      expect(onDisk(dir, "secretword")).toEqual([]);
      expect(onDisk(dir, "Keptword")).not.toHaveLength(0);
      expect(repository.search("keptword", 10).items).toHaveLength(1);
      expect(repository.search("secretword", 10).items).toHaveLength(0);
    });

    it("leaves no copy on disk after the whole history is deleted", () => {
      const { dir, repository, add } = open();
      add("gone", "Secretword goes");

      repository.deleteAll();

      expect(onDisk(dir, "Secretword")).toEqual([]);
      expect(onDisk(dir, "secretword")).toEqual([]);
    });

    it("also clears a row saved before the database was last opened", () => {
      const { dir, add, database } = open();
      add("kept", "Keptword stays");
      add("gone", "Secretword goes");
      database.db!.close();

      createAppDatabase(dir).transcriptRepository.delete("gone");

      expect(onDisk(dir, "secretword")).toEqual([]);
    });

    it("leaves FTS5's own secure-delete option off", () => {
      const { database, repository, add } = open();
      add("gone", "Secretword goes");
      repository.delete("gone");

      expect(database.db!.prepare("SELECT v FROM transcripts_fts_config WHERE k = 'secure-delete'").get()).toBeUndefined();
    });
  });

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
