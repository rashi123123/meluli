import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import {
  recordingAudioChunkSchema,
  recordingAudioPayloadSchema,
  recordingPauseInputSchema,
  recordingStartInputSchema,
  recordingStopInputSchema,
  storedRecordingInputSchema
} from "@shared/schemas";
import type { AppStateSnapshot, StoredRecording, TranscriptRecord } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerRecordingHandlers(
  registry: IpcRegistry,
  dependencies: {
    onStart: (input: ReturnType<typeof recordingStartInputSchema.parse>, event: IpcMainInvokeEvent) => AppStateSnapshot | Promise<AppStateSnapshot>;
    onPause: (input: ReturnType<typeof recordingPauseInputSchema.parse>, event: IpcMainInvokeEvent) => AppStateSnapshot | Promise<AppStateSnapshot>;
    onStop: (input: ReturnType<typeof recordingStopInputSchema.parse>, event: IpcMainInvokeEvent) => AppStateSnapshot | Promise<AppStateSnapshot>;
    onSendAudio: (payload: ReturnType<typeof recordingAudioPayloadSchema.parse>, event: IpcMainInvokeEvent) => Promise<TranscriptRecord>;
    onAudioChunk: (input: ReturnType<typeof recordingAudioChunkSchema.parse>, event: IpcMainInvokeEvent) => Promise<boolean>;
    onListStored: () => Promise<StoredRecording[]>;
    onTranscribeStored: (id: string) => Promise<{ transcript: TranscriptRecord; replaced: boolean }>;
    onDiscardStored: (id: string) => Promise<void>;
    onStoredAudio: (id: string) => Promise<Uint8Array | null>;
  }
): void {
  registry.register(IPC_CHANNELS.recordingStart, (input, event) => dependencies.onStart(recordingStartInputSchema.parse(input), event));
  registry.register(IPC_CHANNELS.recordingPause, (input, event) => dependencies.onPause(recordingPauseInputSchema.parse(input), event));
  registry.register(IPC_CHANNELS.recordingStop, (input, event) => dependencies.onStop(recordingStopInputSchema.parse(input ?? undefined), event));
  registry.register(IPC_CHANNELS.recordingAudioChunk, (input, event) => dependencies.onAudioChunk(recordingAudioChunkSchema.parse(input), event));
  registry.register(IPC_CHANNELS.recordingsList, () => dependencies.onListStored());
  registry.register(IPC_CHANNELS.recordingsTranscribe, (input) => dependencies.onTranscribeStored(storedRecordingInputSchema.parse(input).id));
  registry.register(IPC_CHANNELS.recordingsAudio, (input) => dependencies.onStoredAudio(storedRecordingInputSchema.parse(input).id));
  registry.register(IPC_CHANNELS.recordingsDiscard, (input) => dependencies.onDiscardStored(storedRecordingInputSchema.parse(input).id));
  registry.register(IPC_CHANNELS.recordingSendAudio, (payload, event) =>
    dependencies.onSendAudio(recordingAudioPayloadSchema.parse(payload), event)
  );
}
