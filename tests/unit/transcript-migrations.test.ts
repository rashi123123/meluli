/* @vitest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

describe("runMigrations", () => {
  it("adds model_id to legacy transcript tables so older databases stay readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivrit-legacy-db-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "ivrit-menu-bar.sqlite");

    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        text TEXT NOT NULL,
        imported_file_name TEXT,
        source_title TEXT,
        source_url TEXT,
        duration_ms INTEGER,
        backend TEXT
      );
    `);
    legacyDb.close();

    const appDatabase = createAppDatabase(dir);
    const columns = appDatabase.db
      ?.prepare<unknown[], { name: string }>("PRAGMA table_info(transcripts)")
      .all()
      .map((column) => column.name);

    expect(columns).toContain("model_id");
  });
});
