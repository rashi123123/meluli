import { z } from "zod";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { CallService } from "../../services/calls/call.service";
import { IpcRegistry } from "../registry";

export function registerCallHandlers(
  registry: IpcRegistry,
  dependencies: {
    calls: CallService;
    onOpenAudioSettings: () => boolean | Promise<boolean>;
  }
): void {
  const { calls } = dependencies;
  const id = z.uuid();
  registry.register(IPC_CHANNELS.callAccept, () => calls.accept());
  registry.register(IPC_CHANNELS.callDismiss, () => calls.dismiss());
  registry.register(IPC_CHANNELS.callStop, () => calls.stop());
  registry.register(IPC_CHANNELS.callRetry, (request) => calls.retry(id.parse(request)));
  registry.register(IPC_CHANNELS.callDiscard, (request) => calls.discard(id.parse(request)));
  registry.register(IPC_CHANNELS.callDismissNotice, () => calls.dismissNotice());
  registry.register(IPC_CHANNELS.callOpenAudioSettings, () => dependencies.onOpenAudioSettings());
}
