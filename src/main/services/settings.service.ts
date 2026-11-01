import type { App } from "electron";
import { appSettingsSchema } from "@shared/schemas";
import type { AppSettings } from "@shared/types";
import type { SettingsRepositoryLike } from "../db/database";

export class SettingsService {
  constructor(
    private readonly repository: SettingsRepositoryLike,
    private readonly electronApp?: Pick<App, "setLoginItemSettings" | "getLoginItemSettings">
  ) {}

  getSettings(): AppSettings {
    const current = this.repository.getAll();
    const loginItemEnabled =
      this.electronApp?.getLoginItemSettings?.().openAtLogin ?? current.launchAtLogin;

    return loginItemEnabled === current.launchAtLogin
      ? current
      : {
          ...current,
          launchAtLogin: loginItemEnabled
        };
  }

  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    const validated = appSettingsSchema.parse({
      ...this.getSettings(),
      [key]: value
    });

    if (key === "launchAtLogin") {
      this.electronApp?.setLoginItemSettings?.({ openAtLogin: Boolean(value) });
    }

    return this.repository.set(key, validated[key]);
  }
}
