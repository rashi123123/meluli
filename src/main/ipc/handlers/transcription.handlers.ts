import { IPC_CHANNELS } from "@shared/ipc-channels";
import { IpcRegistry } from "../registry";

export function registerTranscriptionHandlers(
  registry: IpcRegistry,
  dependencies: {
    onCancel: () => boolean | Promise<boolean>;
  }
): void {
  registry.register(IPC_CHANNELS.transcriptionCancel, () => dependencies.onCancel());
}
