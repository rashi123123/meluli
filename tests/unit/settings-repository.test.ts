/* @vitest-environment node */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SettingsRepository } from "@main/db/settings.repository";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const open = (rows: Record<string, unknown>) => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const [key, value] of Object.entries(rows)) db.prepare("INSERT INTO settings VALUES (?, ?)").run(key, JSON.stringify(value));
  return new SettingsRepository(db);
};

describe("term packs in stored settings", () => {
  it("keeps built-in terms off for someone who turned them off before packs existed", () => {
    const repository = open({ built_in_terms: false });
    expect(repository.getAll().termPacks).toEqual([]);
    expect(repository.set("termPacks", ["design"]).termPacks).toEqual(["design"]);
  });

  it("gives everyone else the original packs", () => {
    expect(open({}).getAll().termPacks).toEqual(["ai", "dev", "tools", "product"]);
    expect(open({ built_in_terms: true }).getAll().termPacks).toEqual(["ai", "dev", "tools", "product"]);
  });
});

describe("stored settings this version refuses", () => {
  it("falls back to the default for that setting only and leaves the stored value alone", () => {
    const repository = open({ theme: "a-theme-that-was-removed", hold_key: "not-a-key", remove_filler_words: false });
    const settings = repository.getAll();
    expect(settings.theme).toBe(open({}).getAll().theme);
    expect(settings.holdKey).toBe("right_option");
    expect(settings.removeFillerWords).toBe(false);
    const db = (repository as unknown as { db: import("better-sqlite3").Database }).db;
    expect(db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: JSON.stringify("a-theme-that-was-removed") });
  });

  it("reads past a value that is not JSON", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO settings VALUES (?, ?)").run("remove_filler_words", "{not json");
    expect(new SettingsRepository(db).getAll().removeFillerWords).toBe(true);
  });
});

describe("a stored list this version only partly accepts", () => {
  const entry = (index: number) => ({ id: `e${index}`, heard: `שמע ${index}`, written: `w${index}` });

  it("reads a dictionary past today's limit as its first entries, never as empty", () => {
    const settings = open({ dictionary: Array.from({ length: 510 }, (_, index) => entry(index)) }).getAll();
    expect(settings.dictionary).toHaveLength(500);
    expect(settings.dictionary[0]).toEqual(entry(0));
  });

  it("skips only the dictionary entries it cannot read", () => {
    const settings = open({ dictionary: [entry(1), { id: "", heard: "", written: "" }, entry(2)] }).getAll();
    expect(settings.dictionary.map((item) => item.id)).toEqual(["e1", "e2"]);
  });

  it("puts the entries it could not read back when the list is saved", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const stored = [...Array.from({ length: 510 }, (_, index) => entry(index)), { id: "", heard: "", written: "" }];
    db.prepare("INSERT INTO settings VALUES (?, ?)").run("dictionary", JSON.stringify(stored));
    const repository = new SettingsRepository(db);
    const read = repository.getAll().dictionary;
    expect(read).toHaveLength(500);
    repository.set("dictionary", read.slice(1));
    const saved = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'dictionary'").get() as { value: string }).value) as Array<{ id: string }>;
    expect(saved).toHaveLength(510);
    expect(saved.map((item) => item.id)).not.toContain("e0");
    expect(saved.map((item) => item.id)).toContain("e509");
    expect(saved.at(-1)).toEqual({ id: "", heard: "", written: "" });
  });
});
