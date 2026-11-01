/* @vitest-environment node */
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";
import { runMigrations } from "@main/db/migrations";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const legacy = `CREATE TABLE transcripts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, source_type TEXT NOT NULL, text TEXT NOT NULL, imported_file_name TEXT, duration_ms INTEGER); INSERT INTO transcripts VALUES ('legacy', 1, 'microphone', 'שלום ירושלים', NULL, 1000); PRAGMA user_version=1;`;

describe("legacy history migration", () => {
  it("backs up committed WAL history, preserves records and rebuilds Hebrew search", () => {
    const directory = mkdtempSync(join(tmpdir(), "meluli-history-")); directories.push(directory);
    const original = new Database(join(directory, "ivrit-menu-bar.sqlite"));
    original.pragma("journal_mode = WAL"); original.exec(legacy);
    const application = createAppDatabase(directory);
    try {
      expect(application.transcriptRepository.getById("legacy")?.text).toBe("שלום ירושלים");
      expect(application.transcriptRepository.search("ירושלים", 10).items.map(item => item.id)).toEqual(["legacy"]);
      expect(application.db?.pragma("integrity_check", { simple: true })).toBe("ok");
      const backups = readdirSync(join(directory, "backups")); expect(backups).toHaveLength(1);
      const backup = new Database(join(directory, "backups", backups[0]), { readonly: true });
      try {
        expect(backup.pragma("user_version", { simple: true })).toBe(1);
        expect(backup.prepare("SELECT text FROM transcripts WHERE id='legacy'").get()).toEqual({ text: "שלום ירושלים" });
      } finally { backup.close(); }
    } finally { application.db?.close(); original.close(); }
    const reopened = createAppDatabase(directory);
    try { expect(readdirSync(join(directory, "backups"))).toHaveLength(1); } finally { reopened.db?.close(); }
  });
  it("rolls back schema changes if rebuilding the search index fails", () => {
    const db = new Database(":memory:");
    try {
      db.exec(legacy + "CREATE VIEW transcripts_fts AS SELECT text FROM transcripts;");
      expect(() => runMigrations(db)).toThrow();
      const columns = db.prepare("PRAGMA table_info(transcripts)").all() as { name: string }[];
      expect(columns.some(column => column.name === "raw_text")).toBe(false);
      expect(db.pragma("user_version", { simple: true })).toBe(1);
      expect(db.prepare("SELECT text FROM transcripts").get()).toEqual({ text: "שלום ירושלים" });
    } finally { db.close(); }
  });
});
