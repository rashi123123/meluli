import { IPC_CHANNELS } from "@shared/ipc-channels";
import { youtubeSubmitInputSchema } from "@shared/schemas";
import type { AppStateSnapshot } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerYouTubeHandlers(
  registry: IpcRegistry,
  dependencies: {
    onSubmit: (input: ReturnType<typeof youtubeSubmitInputSchema.parse>) => AppStateSnapshot | Promise<AppStateSnapshot>;
    onCancelActive: () => boolean | Promise<boolean>;
    onCancelPending: () => boolean | Promise<boolean>;
  }
): void {
  registry.register(IPC_CHANNELS.youtubeSubmit, (input) => dependencies.onSubmit(youtubeSubmitInputSchema.parse(input)));
  registry.register(IPC_CHANNELS.youtubeCancelActive, () => dependencies.onCancelActive());
  registry.register(IPC_CHANNELS.youtubeCancelPending, () => dependencies.onCancelPending());
}
