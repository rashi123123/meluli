import type Database from "better-sqlite3";
import { appSettingsSchema } from "@shared/schemas";
import { SETTINGS_KEYS } from "@shared/constants";
import type { AppSettings } from "@shared/types";

const SETTING_NAME_MAP: Record<keyof AppSettings, string> = {
  onboardingCompleted: SETTINGS_KEYS.onboardingCompleted,
  onboarding: SETTINGS_KEYS.onboarding,
  onboardingTracking: SETTINGS_KEYS.onboardingTracking,
  shortcut: SETTINGS_KEYS.shortcut,
  overlayShortcut: SETTINGS_KEYS.overlayShortcut,
  overlayPosition: SETTINGS_KEYS.overlayPosition,
  microphoneDeviceId: SETTINGS_KEYS.microphoneDeviceId,
  completionNotificationsEnabled: SETTINGS_KEYS.completionNotificationsEnabled,
  metalEnabled: SETTINGS_KEYS.metalEnabled,
  launchAtLogin: SETTINGS_KEYS.launchAtLogin,
  theme: SETTINGS_KEYS.theme,
  speedPreference: SETTINGS_KEYS.speedPreference,
  removeFillerWords: SETTINGS_KEYS.removeFillerWords,
  builtInTerms: SETTINGS_KEYS.builtInTerms,
  dictionary: SETTINGS_KEYS.dictionary,
  holdKey: SETTINGS_KEYS.holdKey,
  spokenCommands: SETTINGS_KEYS.spokenCommands,
  autoUpdate: SETTINGS_KEYS.autoUpdate,
  callDetection: SETTINGS_KEYS.callDetection,
  processingTelemetry: SETTINGS_KEYS.processingTelemetry,
  modelState: SETTINGS_KEYS.modelState
};

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  getAll(): AppSettings {
    const rows = this.db
      .prepare<unknown[], { key: string; value: string }>("SELECT key, value FROM settings")
      .all();

    const partial: Record<string, unknown> = {};
    for (const row of rows) {
      const entry = Object.entries(SETTING_NAME_MAP).find(([, dbKey]) => dbKey === row.key);
      if (!entry) {
        continue;
      }

      partial[entry[0]] = JSON.parse(row.value);
    }

    return appSettingsSchema.parse(partial);
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    const dbKey = SETTING_NAME_MAP[key];
    this.db
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(dbKey, JSON.stringify(value));

    return this.getAll();
  }
}
