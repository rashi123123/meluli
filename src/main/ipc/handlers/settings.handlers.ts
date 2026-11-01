import { IPC_CHANNELS } from "@shared/ipc-channels";
import { settingUpdateSchema } from "@shared/schemas";
import type { AppSettings } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerSettingsHandlers(
  registry: IpcRegistry,
  dependencies: {
    onGet: () => AppSettings | Promise<AppSettings>;
    onSet: (input: ReturnType<typeof settingUpdateSchema.parse>) => AppSettings | Promise<AppSettings>;
  }
): void {
  registry.register(IPC_CHANNELS.settingsGet, () => dependencies.onGet());
  registry.register(IPC_CHANNELS.settingsSet, (input) => dependencies.onSet(settingUpdateSchema.parse(input)));
}
