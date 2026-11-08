/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSettingsSchema } from "@shared/schemas";
import { WHISPER_ENGINE, ZIPFORMER_ENGINE, resolveAsrEngine } from "@main/config/asr-engine";
import { TranscriptionService } from "@main/services/transcription.service";
import type { SettingsService } from "@main/services/settings.service";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

type Request = { type: string; jobId?: string; sessionId?: string; modelPath?: string };
let requests: Request[];
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; killed: boolean; kill: ReturnType<typeof vi.fn> };
const reply = (message: object) => child.stdout.write(`${JSON.stringify(message)}\n`);
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise(r => setImmediate(r)); };
const READY_V3 = { type: "ready", protocolVersion: 3, workerVersion: "test", backend: "sherpa-onnx", capabilities: { streaming: true, vad: { supported: false, mode: "none", requiresModelPath: false } } };

const WHISPER_BINARY = process.argv0 === process.execPath ? process.argv[1]! : process.argv0;

function makeService(engine: typeof ZIPFORMER_ENGINE | (() => typeof ZIPFORMER_ENGINE) = ZIPFORMER_ENGINE) {
  const settings = appSettingsSchema.parse({});
  return new TranscriptionService({
    getModelPath: async () => "/models/zipformer/sherpa-onnx",
    binaryPaths: { resourcesBasePath: "/r", whispercppWorkerBinaryPath: WHISPER_BINARY, sherpaOnnxWorkerBinaryPath: process.execPath, ytDlpBinaryPath: "", denoBinaryPath: "" },
    engine
  }, { getSettings: () => settings } as unknown as SettingsService);
}

beforeEach(() => {
  requests = [];
  spawnMock.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _e, callback) { for (const line of chunk.toString().split("\n").filter(Boolean)) requests.push(JSON.parse(line) as Request); callback(); } }),
      killed: false, kill: vi.fn(() => { child.killed = true; return true; })
    });
    return child;
  });
});
afterEach(() => vi.clearAllMocks());

async function openChannel(service: TranscriptionService) {
  const listener = { message: vi.fn(), lost: vi.fn() };
  const opening = service.openLiveChannel(listener);
  await flush();
  reply(READY_V3);
  await flush();
  const warmup = requests.find(r => r.type === "warmup")!;
  expect(warmup.modelPath).toBe("/models/zipformer/sherpa-onnx");
  reply({ type: "warmed", jobId: warmup.jobId });
  return { listener, channel: await opening };
}

describe("streaming engine worker", () => {
  it("runs the sherpa-onnx worker and routes live session messages to the session", async () => {
    const service = makeService();
    expect(service.backend).toBe("sherpa-onnx");
    expect(service.modelId).toBe(`${ZIPFORMER_ENGINE.model.id}@${ZIPFORMER_ENGINE.model.revision}`);
    const { listener, channel } = await openChannel(service);
    expect(spawnMock.mock.calls[0]![0]).toBe(process.execPath);
    expect(channel.send({ type: "begin", sessionId: "s1", modelPath: channel.modelPath })).toBe(true);
    await flush();
    expect(requests.at(-1)).toMatchObject({ type: "begin", sessionId: "s1" });
    reply({ type: "partial", sessionId: "s1", seq: 0, text: "שלום", segments: 0 });
    reply({ type: "error", jobId: "other", message: "not the session's" });
    await flush();
    expect(listener.message).toHaveBeenCalledTimes(1);
    expect(listener.message.mock.calls[0]![0]).toMatchObject({ type: "partial", text: "שלום" });
    // An open session keeps the model loaded.
    expect(service.releaseIfIdle()).toBe(false);
    channel.close();
    expect(channel.send({ type: "cancel_session", sessionId: "s1" })).toBe(false);
    expect(service.releaseIfIdle()).toBe(true);
    service.dispose();
  });

  it("tells the session when the worker dies", async () => {
    const service = makeService();
    const { listener, channel } = await openChannel(service);
    child.emit("close", null, "SIGKILL");
    expect(listener.lost).toHaveBeenCalledTimes(1);
    expect(channel.send({ type: "finish", sessionId: "s1", samples: 0 })).toBe(false);
    service.dispose();
  });

  it("refuses a worker of the other engine", async () => {
    const service = makeService();
    const opening = service.openLiveChannel({ message: vi.fn(), lost: vi.fn() });
    await flush();
    reply({ ...READY_V3, protocolVersion: 2, backend: "whispercpp" });
    await expect(opening).rejects.toBeInstanceOf(Error);
    service.dispose();
  });

  it("follows the person's engine choice: the next use starts the other worker", async () => {
    let chosen = WHISPER_ENGINE;
    const service = makeService(() => chosen);
    expect(service.streaming).toBe(false);
    await expect(service.openLiveChannel({ message: vi.fn(), lost: vi.fn() })).rejects.toBeInstanceOf(Error);
    chosen = ZIPFORMER_ENGINE;
    expect(service.streaming).toBe(true);
    const { channel } = await openChannel(service);
    expect(spawnMock.mock.calls.at(-1)![0]).toBe(process.execPath);
    channel.close();

    chosen = WHISPER_ENGINE;
    const firstWorker = child;
    const warming = service.prewarm();
    await flush();
    expect(firstWorker.kill).toHaveBeenCalled();
    expect(spawnMock.mock.calls.at(-1)![0]).toBe(WHISPER_BINARY);
    reply({ ...READY_V3, protocolVersion: 2, backend: "whispercpp", capabilities: { vad: { supported: true, mode: "whispercpp_native", requiresModelPath: false } } });
    await flush();
    reply({ type: "warmed", jobId: requests.filter(r => r.type === "warmup").at(-1)!.jobId });
    await warming;
    expect(service.backend).toBe("whispercpp");
    service.dispose();
  });

  it("has no live sessions on Whisper", async () => {
    await expect(makeService(WHISPER_ENGINE).openLiveChannel({ message: vi.fn(), lost: vi.fn() })).rejects.toBeInstanceOf(Error);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs the person's choice, and a development override only off the product path", () => {
    expect(resolveAsrEngine(true, "whisper", {}).id).toBe("whisper");
    expect(resolveAsrEngine(true, "zipformer", {}).id).toBe("zipformer");
    expect(resolveAsrEngine(true, "whisper", { MELULI_ASR_ENGINE: "zipformer" }).id).toBe("whisper");
    expect(resolveAsrEngine(true, "zipformer", { MELULI_ASR_ENGINE: "whisper" }).id).toBe("zipformer");
    expect(resolveAsrEngine(false, "whisper", { MELULI_ASR_ENGINE: "zipformer" }).id).toBe("zipformer");
    expect(resolveAsrEngine(true, "whisper", { MELULI_ASR_ENGINE: "zipformer", MELULI_NATIVE_DEVELOPMENT: "1" }).id).toBe("zipformer");
    expect(resolveAsrEngine(false, undefined, {}).id).toBe("whisper");
  });
});
