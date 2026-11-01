import { IPC_CHANNELS } from "@shared/ipc-channels";
import { IpcRegistry } from "../registry";

export function registerShortcutHandlers(
  registry: IpcRegistry,
  dependencies: {
    onGet: () => string | Promise<string>;
    onSet: (accelerator: string) => string | Promise<string>;
  }
): void {
  registry.register(IPC_CHANNELS.shortcutGet, () => dependencies.onGet());
  registry.register(IPC_CHANNELS.shortcutSet, (accelerator) => dependencies.onSet(String(accelerator)));
}
