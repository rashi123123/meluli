import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { AppError } from "@shared/errors/app-error";
import type { InvokeChannelName } from "./policy";

type InvokeHandler<TRequest, TResponse> =
  (request: TRequest, event: IpcMainInvokeEvent) => Promise<TResponse> | TResponse;

export class IpcRegistry {
  private readonly registeredChannels = new Set<string>();

  constructor(
    private readonly options: {
      validateEvent: (channel: InvokeChannelName, event: IpcMainInvokeEvent) => void;
    }
  ) {}

  register<TRequest, TResponse>(channel: InvokeChannelName, handler: InvokeHandler<TRequest, TResponse>): void {
    if (this.registeredChannels.has(channel)) {
      throw new Error(`Duplicate IPC handler registration for ${channel}`);
    }

    ipcMain.handle(channel, async (event, request) => {
      try {
        this.options.validateEvent(channel, event);
        return await handler(request as TRequest, event);
      } catch (error) {
        const appError = AppError.fromUnknown(error);

        if (!(error instanceof AppError)) {
          console.error(`[ipc] ${channel} failed`, { code: appError.code });
        }

        const thrown = Object.assign(new Error(appError.message), appError.toJSON());
        throw thrown;
      }
    });

    this.registeredChannels.add(channel);
  }
}
