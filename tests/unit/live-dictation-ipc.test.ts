/* @vitest-environment node */
// The stop path on the streaming engine: whatever the live session did, the workflow runs once,
// with the session's text when it is whole and without it (a full decode) when it is not.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { RecordingAudioPayload } from "@shared/types";
import { ZIPFORMER_ENGINE, WHISPER_ENGINE } from "@main/config/asr-engine";
import { ExperimentalDictationIpc } from "@main/ipc/experimental-dictation.ipc";
import type { IpcRegistry } from "@main/ipc/registry";
import type { LiveChannel, LiveChannelListener } from "@main/services/transcription.service";
import type { LiveRequest } from "@main/services/transcription-protocol";

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

let handlers: Map<string, (input: unknown, event: unknown) => unknown>;
let sent: LiveRequest[];
let listener: LiveChannelListener | null;
let workflow: { transcribeRecordingAudio: ReturnType<typeof vi.fn> };
const event = { sender: { id: 7, once: vi.fn() } };

function setup(engine = ZIPFORMER_ENGINE) {
  handlers = new Map(); sent = []; listener = null;
  workflow = { transcribeRecordingAudio: vi.fn(async () => ({ id: "t1" })) };
  const channel: LiveChannel = { modelPath: "/m/sherpa-onnx", send: (r) => { sent.push(r); return true; }, close: () => undefined };
  const service = {
    openLiveChannel: vi.fn(async (next: LiveChannelListener) => { listener = next; return channel; }),
    backend: "sherpa-onnx", modelId: "zipformer@test", cancel: vi.fn(), streaming: engine.streaming
  };
  const ipc = new ExperimentalDictationIpc({
    isPackaged: true,
    database: { paths: { userDataPath: "/tmp/profile" } },
    runtime: { assertRecordingOwner: vi.fn(), send: vi.fn(), getState: () => ({ overlaySession: null }) },
    getTranscriptionService: () => service,
    getTranscriptionWorkflow: () => workflow
  } as never);
  ipc.register({ register: (channelName: string, handler: never) => handlers.set(channelName, handler) } as unknown as IpcRegistry);
  return ipc;
}

const pcm = (n: number, phase = 0) => Float32Array.from({ length: n }, (_, i) => Math.sin((i + phase) / 30) * 0.2);
const payload = (samples: Float32Array): RecordingAudioPayload => ({ pcm: samples, sampleRate: 16_000, durationMs: samples.length / 16 });

async function begin(): Promise<string> {
  const result = await handlers.get(IPC_CHANNELS.dictationBegin)!(undefined, event) as { sessionId: string; live: boolean };
  expect(result.live).toBe(true);
  await flush();
  listener!.message({ type: "begun", sessionId: result.sessionId });
  return result.sessionId;
}
const chunk = (sessionId: string, sequence: number, samples: Float32Array) =>
  handlers.get(IPC_CHANNELS.dictationChunk)!({ sessionId, sequence, pcm: samples }, event);

describe("live dictation stop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is off for Whisper, and never turns on the research archive", async () => {
    const whisper = setup(WHISPER_ENGINE);
    expect(await handlers.get(IPC_CHANNELS.dictationBegin)!(undefined, event)).toBeNull();
    expect(whisper.finishIfActive(payload(pcm(100)))).toBeNull();
    setup();
    expect(await handlers.get(IPC_CHANNELS.dictationEnabled)!(undefined, event)).toBe(false);
  });

  it("hands the session's text to the workflow once", async () => {
    const ipc = setup();
    const id = await begin();
    const audio = pcm(4096);
    await chunk(id, 0, audio.subarray(0, 2048));
    await chunk(id, 1, audio.subarray(2048));
    const done = ipc.finishIfActive(payload(audio))!;
    await flush();
    expect(sent.filter(r => r.type === "finish")).toEqual([{ type: "finish", sessionId: id, samples: 4096 }]);
    listener!.message({ type: "final", sessionId: id, result: { text: "שלום, Meluli", language: "he", segments: [{ start: 0, end: 0.25, text: "שלום, Meluli" }] } });
    await expect(done).resolves.toEqual({ id: "t1" });
    expect(workflow.transcribeRecordingAudio).toHaveBeenCalledTimes(1);
    expect(workflow.transcribeRecordingAudio.mock.calls[0]![1]).toMatchObject({ text: "שלום, Meluli", backend: "sherpa-onnx", modelId: "zipformer@test" });
    expect(ipc.finishIfActive(payload(audio))).toBeNull();
  });

  it("decodes the whole recording once when the live session broke", async () => {
    const ipc = setup();
    const id = await begin();
    await chunk(id, 0, pcm(2048));
    await chunk(id, 2, pcm(2048, 5));
    await expect(ipc.finishIfActive(payload(pcm(6144)))!).resolves.toEqual({ id: "t1" });
    expect(workflow.transcribeRecordingAudio).toHaveBeenCalledTimes(1);
    expect(workflow.transcribeRecordingAudio.mock.calls[0]![1]).toBeUndefined();
    expect(sent.some(r => r.type === "finish")).toBe(false);
  });

  it("a cancel while waiting for the text ends the dictation with nothing stored or pasted", async () => {
    const ipc = setup();
    const id = await begin();
    await chunk(id, 0, pcm(2048));
    const done = ipc.finishIfActive(payload(pcm(2048)))!;
    await flush();
    await expect(ipc.cancelIfRunning()).resolves.toBe(true);
    await expect(done).rejects.toMatchObject({ name: "TranscriptionCanceledError" });
    listener!.message({ type: "final", sessionId: id, result: { text: "מאוחר מדי" } });
    await flush();
    expect(workflow.transcribeRecordingAudio).not.toHaveBeenCalled();
    await expect(ipc.cancelIfRunning()).resolves.toBe(false);
  });

  it("a recording stopped without sending audio closes the session", async () => {
    const ipc = setup();
    const id = await begin();
    await chunk(id, 0, pcm(2048));
    await ipc.stop(7);
    expect(sent.at(-1)).toEqual({ type: "cancel_session", sessionId: id });
    expect(ipc.finishIfActive(payload(pcm(2048)))).toBeNull();
  });
});
