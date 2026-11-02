import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { MODELS_DIR_NAME, TRANSCRIPTS_DIR_NAME } from "@shared/constants";
import { appSettingsSchema } from "@shared/schemas";
import type { AppSettings, TranscriptListResult, TranscriptRecord } from "@shared/types";
import { markPerformanceAudit } from "../perf-audit";
import type { TranscriptContent } from "../services/transcript-edit.service";
import { runMigrations, DATABASE_SCHEMA_VERSION } from "./migrations";
import { SettingsRepository } from "./settings.repository";
import { TranscriptRepository } from "./transcript.repository";
import { isMockMode } from "../config/mock-mode";

const require = createRequire(import.meta.url);

export interface AppPaths {
  userDataPath: string;
  databasePath: string;
  transcriptsDir: string;
  modelsDir: string;
}

export interface TranscriptRepositoryLike {
  create(record: TranscriptRecord): TranscriptRecord;
  getById(id: string): TranscriptRecord | null;
  list(limit: number, cursor?: number | null): TranscriptListResult;
  search(query: string, limit: number, cursor?: number | null): TranscriptListResult;
  update(id: string, content: TranscriptContent): TranscriptRecord | null;
  restoreOriginal(id: string): TranscriptRecord | null;
  delete(id: string): boolean;
  deleteAll(): boolean;
}

export interface SettingsRepositoryLike {
  getAll(): AppSettings;
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings;
}

export interface AppDatabase {
  db: import("better-sqlite3").Database | null;
  paths: AppPaths;
  transcriptRepository: TranscriptRepositoryLike;
  settingsRepository: SettingsRepositoryLike;
}

function createMockRepositories(): Pick<AppDatabase, "db" | "settingsRepository" | "transcriptRepository"> {
  let settings = appSettingsSchema.parse({});
  let transcripts: TranscriptRecord[] = [];
  const originals = new Map<string, TranscriptRecord>();
  const replaceTranscript = (record: TranscriptRecord) => {
    transcripts = transcripts.map((item) => (item.id === record.id ? record : item));
    return record;
  };

  const listRecords = (items: TranscriptRecord[], limit: number, cursor: number | null = null): TranscriptListResult => {
    const filtered = cursor === null ? items : items.filter((item) => item.createdAt < cursor);
    const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
    const sliced = sorted.slice(0, limit + 1);
    const page = sliced.slice(0, limit);
    return {
      items: page,
      nextCursor: sliced.length > limit ? page.at(-1)?.createdAt ?? null : null
    };
  };

  return {
    db: null,
    settingsRepository: {
      getAll: () => settings,
      set: (key, value) => {
        settings = appSettingsSchema.parse({
          ...settings,
          [key]: value
        });
        return settings;
      }
    },
    transcriptRepository: {
      create: (record) => {
        transcripts = [record, ...transcripts.filter((item) => item.id !== record.id)];
        return record;
      },
      getById: (id) => transcripts.find((item) => item.id === id) ?? null,
      list: (limit, cursor = null) => listRecords(transcripts, limit, cursor),
      search: (query, limit, cursor = null) =>
        listRecords(
          transcripts.filter((item) =>
            `${item.text} ${item.rawText ?? ""} ${item.importedFileName ?? ""} ${item.sourceTitle ?? ""} ${item.sourceUrl ?? ""} ${(item.possibleTerms ?? []).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase())
          ),
          limit,
          cursor
        ),
      update: (id, content) => {
        const record = transcripts.find((item) => item.id === id);
        if (!record) return null;
        if (!originals.has(id)) originals.set(id, record);
        return replaceTranscript({ ...record, ...content, editedAt: Date.now() });
      },
      restoreOriginal: (id) => {
        const original = originals.get(id);
        originals.delete(id);
        return original ? replaceTranscript(original) : transcripts.find((item) => item.id === id) ?? null;
      },
      delete: (id) => {
        const before = transcripts.length;
        transcripts = transcripts.filter((item) => item.id !== id);
        originals.delete(id);
        return transcripts.length !== before;
      },
      deleteAll: () => {
        transcripts = [];
        originals.clear();
        return true;
      }
    }
  };
}

export function createAppDatabase(userDataPath: string): AppDatabase {
  markPerformanceAudit("database:init:start");
  const paths: AppPaths = {
    userDataPath,
    databasePath: join(userDataPath, "ivrit-menu-bar.sqlite"),
    transcriptsDir: join(userDataPath, TRANSCRIPTS_DIR_NAME),
    modelsDir: join(userDataPath, MODELS_DIR_NAME)
  };

  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  mkdirSync(paths.transcriptsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.modelsDir, { recursive: true, mode: 0o700 });

  if (isMockMode()) {
    markPerformanceAudit("database:init:mock");
    return {
      paths,
      ...createMockRepositories()
    };
  }

  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  markPerformanceAudit("database:open:start");
  closeSync(openSync(paths.databasePath, "a", 0o600));
  const db = new Database(paths.databasePath);
  db.pragma("trusted_schema = OFF");
  db.pragma("secure_delete = ON");
  markPerformanceAudit("database:open:end");
  markPerformanceAudit("database:migrations:start");
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    const hasHistory = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcripts'").get());
    if (hasHistory && version < DATABASE_SCHEMA_VERSION) {
      const backupDirectory = join(userDataPath, "backups");
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      const backupPath = join(backupDirectory, `ivrit-menu-bar-before-v${DATABASE_SCHEMA_VERSION}-${Date.now()}.sqlite`);
      // SQLite creates a consistent snapshot including committed WAL data.
      db.prepare("VACUUM INTO ?").run(backupPath);
      chmodSync(backupPath, 0o600);
    }
    runMigrations(db);
    chmodSync(paths.databasePath, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }
  markPerformanceAudit("database:migrations:end");
  markPerformanceAudit("database:init:end");

  return {
    db,
    paths,
    transcriptRepository: new TranscriptRepository(db),
    settingsRepository: new SettingsRepository(db)
  };
}
