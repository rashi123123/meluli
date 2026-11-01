import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { ModelState } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerModelHandlers(
  registry: IpcRegistry,
  dependencies: {
    onStatus: () => ModelState | Promise<ModelState>;
    onDownload: () => Promise<ModelState>;
    onRemove: () => ModelState | Promise<ModelState>;
  }
): void {
  registry.register(IPC_CHANNELS.modelStatus, () => dependencies.onStatus());
  registry.register(IPC_CHANNELS.modelDownload, () => dependencies.onDownload());
  registry.register(IPC_CHANNELS.modelRemove, () => dependencies.onRemove());
}
