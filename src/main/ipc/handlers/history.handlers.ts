import { IPC_CHANNELS } from "@shared/ipc-channels";
import {
  transcriptDeleteSchema,
  transcriptListQuerySchema,
  transcriptRestoreSchema,
  transcriptSearchQuerySchema,
  transcriptUpdateSchema
} from "@shared/schemas";
import type { TranscriptListResult, TranscriptRecord } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerHistoryHandlers(
  registry: IpcRegistry,
  dependencies: {
    onList: (input: ReturnType<typeof transcriptListQuerySchema.parse>) => TranscriptListResult | Promise<TranscriptListResult>;
    onGet: (id: string) => TranscriptRecord | null | Promise<TranscriptRecord | null>;
    onSearch: (input: ReturnType<typeof transcriptSearchQuerySchema.parse>) => TranscriptListResult | Promise<TranscriptListResult>;
    onUpdate: (input: ReturnType<typeof transcriptUpdateSchema.parse>) => TranscriptRecord | null | Promise<TranscriptRecord | null>;
    onRestoreOriginal: (input: ReturnType<typeof transcriptRestoreSchema.parse>) => TranscriptRecord | null | Promise<TranscriptRecord | null>;
    onDelete: (input: ReturnType<typeof transcriptDeleteSchema.parse>) => boolean | Promise<boolean>;
    onDeleteAll: () => boolean | Promise<boolean>;
  }
): void {
  registry.register(IPC_CHANNELS.historyList, (input) => dependencies.onList(transcriptListQuerySchema.parse(input ?? {})));
  registry.register(IPC_CHANNELS.historyGet, (id) => dependencies.onGet(String(id)));
  registry.register(IPC_CHANNELS.historySearch, (input) =>
    dependencies.onSearch(transcriptSearchQuerySchema.parse(input ?? {}))
  );
  registry.register(IPC_CHANNELS.historyUpdate, (input) => dependencies.onUpdate(transcriptUpdateSchema.parse(input)));
  registry.register(IPC_CHANNELS.historyRestoreOriginal, (input) =>
    dependencies.onRestoreOriginal(transcriptRestoreSchema.parse(input))
  );
  registry.register(IPC_CHANNELS.historyDelete, (input) => dependencies.onDelete(transcriptDeleteSchema.parse(input)));
  registry.register(IPC_CHANNELS.historyDeleteAll, () => dependencies.onDeleteAll());
}
