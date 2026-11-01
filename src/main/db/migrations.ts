import type Database from "better-sqlite3";
import { markPerformanceAudit } from "../perf-audit";

export const DATABASE_SCHEMA_VERSION = 3;
const SEARCH_INDEX_SCHEMA_VERSION = DATABASE_SCHEMA_VERSION;

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db
      .prepare<unknown[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      )
      .get(name)
  );
}

function hasTrigger(db: Database.Database, name: string): boolean {
  return Boolean(
    db
      .prepare<unknown[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1"
      )
      .get(name)
  );
}

function ensureTranscriptSearchIndex(db: Database.Database): void {
  markPerformanceAudit("database:fts:ensure:start");
  const currentSchemaVersion = db.pragma("user_version", { simple: true }) as number;
  const searchIndexReady =
    hasTable(db, "transcripts_fts") &&
    hasTrigger(db, "transcripts_ai") &&
    hasTrigger(db, "transcripts_ad") &&
    hasTrigger(db, "transcripts_au");

  if (currentSchemaVersion >= SEARCH_INDEX_SCHEMA_VERSION && searchIndexReady) {
    markPerformanceAudit("database:fts:ensure:ready");
    return;
  }

  markPerformanceAudit("database:fts:rebuild:start", {
    currentSchemaVersion
  });
  db.exec(`
    DROP TRIGGER IF EXISTS transcripts_ai;
    DROP TRIGGER IF EXISTS transcripts_ad;
    DROP TRIGGER IF EXISTS transcripts_au;
    DROP TABLE IF EXISTS transcripts_fts;

    CREATE VIRTUAL TABLE transcripts_fts USING fts5(
      text,
      raw_text,
      imported_file_name,
      source_title,
      source_url,
      possible_terms_json,
      content='transcripts',
      content_rowid='rowid'
    );

    INSERT INTO transcripts_fts(transcripts_fts) VALUES ('rebuild');

    CREATE TRIGGER transcripts_ai AFTER INSERT ON transcripts BEGIN
      INSERT INTO transcripts_fts(rowid, text, raw_text, imported_file_name, source_title, source_url, possible_terms_json)
      VALUES (
        new.rowid,
        new.text,
        coalesce(new.raw_text, ''),
        coalesce(new.imported_file_name, ''),
        coalesce(new.source_title, ''),
        coalesce(new.source_url, ''),
        coalesce(new.possible_terms_json, '')
      );
    END;

    CREATE TRIGGER transcripts_ad AFTER DELETE ON transcripts BEGIN
      INSERT INTO transcripts_fts(transcripts_fts, rowid, text, raw_text, imported_file_name, source_title, source_url, possible_terms_json)
      VALUES (
        'delete',
        old.rowid,
        old.text,
        coalesce(old.raw_text, ''),
        coalesce(old.imported_file_name, ''),
        coalesce(old.source_title, ''),
        coalesce(old.source_url, ''),
        coalesce(old.possible_terms_json, '')
      );
    END;

    CREATE TRIGGER transcripts_au AFTER UPDATE ON transcripts BEGIN
      INSERT INTO transcripts_fts(transcripts_fts, rowid, text, raw_text, imported_file_name, source_title, source_url, possible_terms_json)
      VALUES (
        'delete',
        old.rowid,
        old.text,
        coalesce(old.raw_text, ''),
        coalesce(old.imported_file_name, ''),
        coalesce(old.source_title, ''),
        coalesce(old.source_url, ''),
        coalesce(old.possible_terms_json, '')
      );
      INSERT INTO transcripts_fts(rowid, text, raw_text, imported_file_name, source_title, source_url, possible_terms_json)
      VALUES (
        new.rowid,
        new.text,
        coalesce(new.raw_text, ''),
        coalesce(new.imported_file_name, ''),
        coalesce(new.source_title, ''),
        coalesce(new.source_url, ''),
        coalesce(new.possible_terms_json, '')
      );
    END;
  `);

  db.pragma(`user_version = ${SEARCH_INDEX_SCHEMA_VERSION}`);
  markPerformanceAudit("database:fts:rebuild:end", {
    schemaVersion: SEARCH_INDEX_SCHEMA_VERSION
  });
}

export function runMigrations(db: Database.Database): void {
  markPerformanceAudit("database:migrations:run:start");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      text TEXT NOT NULL,
      imported_file_name TEXT,
      source_title TEXT,
      source_url TEXT,
      duration_ms INTEGER,
      backend TEXT,
      model_id TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const transcriptColumns = db
    .prepare<unknown[], { name: string }>("PRAGMA table_info(transcripts)")
    .all()
    .map((column) => column.name);

  if (!transcriptColumns.includes("source_title")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN source_title TEXT;");
  }

  if (!transcriptColumns.includes("source_url")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN source_url TEXT;");
  }

  if (!transcriptColumns.includes("raw_text")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN raw_text TEXT;");
  }

  if (!transcriptColumns.includes("backend")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN backend TEXT;");
  }

  if (!transcriptColumns.includes("model_id")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN model_id TEXT;");
  }

  if (!transcriptColumns.includes("paragraphs_json")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN paragraphs_json TEXT;");
  }

  if (!transcriptColumns.includes("possible_terms_json")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN possible_terms_json TEXT;");
  }

  if (!transcriptColumns.includes("uncertain_segments_json")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN uncertain_segments_json TEXT;");
  }

  if (!transcriptColumns.includes("language")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN language TEXT;");
  }

  if (!transcriptColumns.includes("segments_json")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN segments_json TEXT;");
  }

  if (!transcriptColumns.includes("original_json")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN original_json TEXT;");
  }

  if (!transcriptColumns.includes("edited_at")) {
    db.exec("ALTER TABLE transcripts ADD COLUMN edited_at INTEGER;");
  }

  ensureTranscriptSearchIndex(db);
  })();
  markPerformanceAudit("database:migrations:run:end");
}
