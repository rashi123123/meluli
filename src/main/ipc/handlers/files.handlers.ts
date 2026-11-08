import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { droppedAudioPathSchema, transcriptExportSchema } from "@shared/schemas";
import type { ImportAudioResult, StoragePathsInfo } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerFileHandlers(
  registry: IpcRegistry,
  dependencies: {
    onRevealPath: (targetPath: string) => boolean | Promise<boolean>;
    onOpenExternal: (targetUrl: string) => boolean | Promise<boolean>;
    onStoragePaths: () => StoragePathsInfo | Promise<StoragePathsInfo>;
    onImportAudio: () => Promise<ImportAudioResult>;
    onImportDroppedAudio: (path: string) => Promise<ImportAudioResult>;
    onExportTranscript: (input: ReturnType<typeof transcriptExportSchema.parse>, event: IpcMainInvokeEvent) => Promise<boolean>;
  }
): void {
  registry.register(IPC_CHANNELS.fileRevealPath, (targetPath) => dependencies.onRevealPath(String(targetPath ?? "")));
  registry.register(IPC_CHANNELS.fileOpenExternal, (targetUrl) => dependencies.onOpenExternal(String(targetUrl ?? "")));
  registry.register(IPC_CHANNELS.fileStoragePaths, () => dependencies.onStoragePaths());
  registry.register(IPC_CHANNELS.fileImportAudio, () => dependencies.onImportAudio());
  registry.register(IPC_CHANNELS.fileImportDroppedAudio, (input) => dependencies.onImportDroppedAudio(droppedAudioPathSchema.parse(input)));
  registry.register(IPC_CHANNELS.fileExportTranscript, (input, event) =>
    dependencies.onExportTranscript(transcriptExportSchema.parse(input), event)
  );
}
