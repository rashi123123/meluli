import type Database from "better-sqlite3";
import { appSettingsSchema } from "@shared/schemas";
import { LEGACY_BUILT_IN_TERMS_KEY, SETTINGS_KEYS } from "@shared/constants";
import type { AppSettings } from "@shared/types";

/** Every setting has its database key; the type fails the build if one is missing. */
const SETTING_NAME_MAP: Record<keyof AppSettings, string> = SETTINGS_KEYS;

export class SettingsRepository {
  /** List entries the last read could not take in, kept so a later save of that list does not drop them. */
  private unread = new Map<string, unknown[]>();

  constructor(private readonly db: Database.Database) {}

  getAll(): AppSettings {
    const rows = this.db
      .prepare<unknown[], { key: string; value: string }>("SELECT key, value FROM settings")
      .all();

    const partial: Record<string, unknown> = {};
    for (const row of rows) {
      const name = row.key === LEGACY_BUILT_IN_TERMS_KEY
        ? "builtInTerms"
        : Object.entries(SETTING_NAME_MAP).find(([, dbKey]) => dbKey === row.key)?.[0];
      if (!name) {
        continue;
      }

      try {
        partial[name] = JSON.parse(row.value);
      } catch {
        console.warn(`[settings] ${name} is not readable, using its default`);
      }
    }

    const unread = new Map<string, unknown[]>();
    const settings = parseStoredSettings(partial, unread);
    this.unread = unread;
    return settings;
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    const dbKey = SETTING_NAME_MAP[key];
    this.db
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(dbKey, JSON.stringify(Array.isArray(value) ? [...value, ...(this.unread.get(key) ?? [])] : value));

    return this.getAll();
  }
}

/** One stored value an older or newer version wrote in a shape this one refuses (a removed theme, a
 * list over today's limit) falls back to that setting's default instead of stopping the app from
 * opening. Nothing is written back here; list entries left out are collected in `unread`, so that
 * saving the list later puts them back after what was edited. */
export function parseStoredSettings(stored: Record<string, unknown>, unread = new Map<string, unknown[]>()): AppSettings {
  const partial = { ...stored };
  for (;;) {
    const result = appSettingsSchema.safeParse(partial);
    if (result.success) return result.data;
    let changed = false;
    // A list keeps what it can: an entry this version refuses is skipped, and a list past today's
    // limit is cut to it, so a long dictionary never reads back as empty.
    const badEntries = new Map<string, Set<number>>();
    for (const issue of result.error.issues) {
      const [key, index] = issue.path;
      if (typeof key !== "string" || !(key in partial)) continue;
      const value = partial[key];
      if (Array.isArray(value) && typeof index === "number") {
        badEntries.set(key, (badEntries.get(key) ?? new Set()).add(index));
      } else if (Array.isArray(value) && issue.code === "too_big" && typeof issue.maximum === "number" && value.length > issue.maximum) {
        console.warn(`[settings] ${key} is longer than this version allows, reading the first ${issue.maximum}`);
        unread.set(key, [...(unread.get(key) ?? []), ...value.slice(Number(issue.maximum))]);
        partial[key] = value.slice(0, Number(issue.maximum));
        changed = true;
      } else {
        console.warn(`[settings] ${key} is not valid, using its default`);
        delete partial[key];
        changed = true;
      }
    }
    for (const [key, indexes] of badEntries) {
      console.warn(`[settings] ${key} has ${indexes.size} entries this version cannot read, skipping them`);
      const list = partial[key] as unknown[];
      unread.set(key, [...list.filter((_, index) => indexes.has(index)), ...(unread.get(key) ?? [])]);
      partial[key] = list.filter((_, index) => !indexes.has(index));
      changed = true;
    }
    // An issue no single stored setting explains cannot be fixed by dropping one.
    if (!changed) throw result.error;
  }
}
