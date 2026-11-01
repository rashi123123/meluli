import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { recordingAudioPayloadSchema, recordingPauseInputSchema, recordingStartInputSchema } from "@shared/schemas";
import type { AppStateSnapshot, TranscriptRecord } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerRecordingHandlers(
  registry: IpcRegistry,
  dependencies: {
    onStart: (input: ReturnType<typeof recordingStartInputSchema.parse>, event: IpcMainInvokeEvent) => AppStateSnapshot | Promise<AppStateSnapshot>;
    onPause: (input: ReturnType<typeof recordingPauseInputSchema.parse>, event: IpcMainInvokeEvent) => AppStateSnapshot | Promise<AppStateSnapshot>;
    onStop: (event: IpcMainInvokeEvent) => AppStateSnapshot | Promise<AppStateSnapshot>;
    onSendAudio: (payload: ReturnType<typeof recordingAudioPayloadSchema.parse>, event: IpcMainInvokeEvent) => Promise<TranscriptRecord>;
  }
): void {
  registry.register(IPC_CHANNELS.recordingStart, (input, event) => dependencies.onStart(recordingStartInputSchema.parse(input), event));
  registry.register(IPC_CHANNELS.recordingPause, (input, event) => dependencies.onPause(recordingPauseInputSchema.parse(input), event));
  registry.register(IPC_CHANNELS.recordingStop, (_input, event) => dependencies.onStop(event));
  registry.register(IPC_CHANNELS.recordingSendAudio, (payload, event) =>
    dependencies.onSendAudio(recordingAudioPayloadSchema.parse(payload), event)
  );
}
