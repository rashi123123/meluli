/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_WEIGHT_FILE } from "@shared/constants";
import { he } from "@shared/locale";
import { appSettingsSchema } from "@shared/schemas";
import { buildWorkerEnv, MODEL_IDLE_TIMEOUT_MS, TranscriptionService } from "@main/services/transcription.service";
import type { SettingsService } from "@main/services/settings.service";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

type Request = { type: string; jobId?: string };
let requests: Request[];
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; killed: boolean; kill: ReturnType<typeof vi.fn> };
let service: TranscriptionService;
let modelPath: string;
const reply = (message: object) => child.stdout.write(`${JSON.stringify(message)}\n`);
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  requests = [];
  modelPath = mkdtempSync(join(tmpdir(), "meluli-worker-test-"));
  writeFileSync(join(modelPath, DEFAULT_MODEL_WEIGHT_FILE), "fixture");
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) { requests.push(JSON.parse(chunk.toString()) as Request); callback(); } }),
    killed: false,
    kill: vi.fn(() => { child.killed = true; return true; })
  });
  spawnMock.mockReturnValue(child);
  const settings = appSettingsSchema.parse({ modelState: { filePath: modelPath, status: "ready" } });
  service = new TranscriptionService({
    getModelPath: async () => modelPath,
    binaryPaths: { resourcesBasePath: modelPath, whispercppWorkerBinaryPath: process.execPath, ytDlpBinaryPath: "", denoBinaryPath: "" },
  }, { getSettings: () => settings } as SettingsService);
});

afterEach(() => {
  service.dispose();
  child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks();
  rmSync(modelPath, { recursive: true, force: true });
});

async function startWarmup() {
  const task = service.prewarm();
  await flush();
  reply({ type: "ready", protocolVersion: 2, workerVersion: "test", backend: "whispercpp", capabilities: { vad: { supported: false, mode: "none", requiresModelPath: false } } });
  await flush();
  const request = requests.find(item => item.type === "warmup");
  expect(request).toBeDefined();
  return { task, jobId: request!.jobId };
}

describe("transcription worker lifecycle (simulated protocol, no ASR)", () => {
  it("keeps warmup pending through progress and settles only on warmed", async () => {
    const { task, jobId } = await startWarmup();
    let settled = false;
    void task.then(() => { settled = true; });
    reply({ type: "progress", jobId, stage: "loading" });
    await flush();
    expect(settled).toBe(false);
    reply({ type: "warmed", jobId });
    await flush();
    expect(settled).toBe(true);
    await task;
  });
  it("releases exactly after five idle minutes, but never during a recording", async () => {
    service.setRecordingActive(true);
    const { task, jobId } = await startWarmup();
    reply({ type: "warmed", jobId });
    await task;
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_TIMEOUT_MS * 2);
    expect(child.kill).not.toHaveBeenCalled();
    service.setRecordingActive(false);
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_TIMEOUT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reserves a single job during asynchronous model warmup", async () => {
    const { task, jobId } = await startWarmup();
    const input = { wavPath: "/fixture.wav", sourceType: "microphone" as const, durationMs: 1000 };
    const transcription = service.transcribe(input);
    await expect(service.transcribe(input)).rejects.toThrow();
    reply({ type: "progress", jobId, stage: "loading" });
    reply({ type: "warmed", jobId });
    await task;
    await flush();
    const request = requests.find(item => item.type === "transcribe")!;
    expect(request).toBeDefined();
    expect(service.releaseIfIdle()).toBe(false);
    reply({ type: "result", jobId: request.jobId, result: { text: "שלום", language: "he", segments: [] } });
    await expect(transcription).resolves.toMatchObject({ text: "שלום" });
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("ignores a partial message without settling the job", async () => {
    const { task, jobId } = await startWarmup();
    reply({ type: "partial", jobId, text: "טקסט" });
    await flush();
    let settled = false;
    void task.finally(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    reply({ type: "warmed", jobId });
    await task;
  });

  it.each(["ct2", "nemo"])("refuses a worker that reports the %s backend", async (backend) => {
    const task = service.prewarm();
    const refused = expect(task).rejects.toThrow();
    await flush();
    reply({ type: "ready", protocolVersion: 2, workerVersion: "test", backend, capabilities: { vad: { supported: false, mode: "none", requiresModelPath: false } } });
    await refused;
  });

  it("cancels while waiting for startup and settles every pending promise", async () => {
    const transcription = service.transcribe({ wavPath: "/fixture.wav", sourceType: "microphone", durationMs: 1000 });
    const canceled = expect(transcription).rejects.toMatchObject({ name: "TranscriptionCanceledError" });
    await flush();
    expect(service.cancel()).toBe(true);
    await canceled;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispose rejects a pending warmup and prevents future work", async () => {
    const { task } = await startWarmup();
    const canceled = expect(task).rejects.toMatchObject({ name: "TranscriptionCanceledError" });
    service.dispose();
    await canceled;
    await expect(service.prewarm()).rejects.toMatchObject({ name: "TranscriptionCanceledError" });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("reports invalid model text in Hebrew and keeps the worker for the next job", async () => {
    const { task, jobId } = await startWarmup();
    reply({ type: "warmed", jobId }); await flush(); await task;
    const transcription = service.transcribe({ wavPath: "/fixture.wav", sourceType: "microphone", durationMs: 1000 });
    const failed = expect(transcription).rejects.toThrow(he.transcriptionInvalidOutput);
    await flush();
    reply({ type: "error", jobId: requests.at(-1)?.jobId, code: "invalid_utf8", message: "ASR returned invalid Unicode. No text was inserted." });
    await failed;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("ignores worker output that is valid JSON but not an object", async () => {
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { task, jobId } = await startWarmup();
      const lines = ["5", "\"text\"", "true", "null", "[]"];
      for (const line of lines) child.stdout.write(`${line}\n`);
      await flush();
      reply({ type: "warmed", jobId }); await flush(); await task;
      const transcription = service.transcribe({ wavPath: "/fixture.wav", sourceType: "microphone", durationMs: 1000 });
      await flush();
      for (const line of lines) child.stdout.write(`${line}\n`);
      await flush();
      reply({ type: "result", jobId: requests.at(-1)?.jobId, result: { text: "שלום", language: "he", segments: [] } });
      await expect(transcription).resolves.toMatchObject({ text: "שלום" });
      expect(uncaught).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(lines.length * 2);
    } finally {
      process.off("uncaughtException", uncaught);
      error.mockRestore();
    }
  });

  it("reads text the worker escaped as ASCII", async () => {
    const { task, jobId } = await startWarmup();
    reply({ type: "warmed", jobId }); await flush(); await task;
    const transcription = service.transcribe({ wavPath: "/fixture.wav", sourceType: "microphone", durationMs: 1000 });
    await flush();
    child.stdout.write(`{"type":"result","jobId":"${requests.at(-1)?.jobId}","result":{"text":"\\u05e9\\u05dc\\u05d5\\u05dd \\u2028 \\ud83d\\ude00","language":"he","segments":[]}}\n`);
    await expect(transcription).resolves.toMatchObject({ text: expect.stringMatching(/^שלום\s+😀$/u) });
  });

  it("has the native worker escape everything past ASCII", () => {
    expect(readFileSync(join(process.cwd(), "native/whisper-worker.cpp"), "utf8")).toContain("std::cout << value.dump(-1, ' ', true) << std::endl;");
  });

  it("starts the worker with an allowlisted environment and the research overrides", async () => {
    const planted = { DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", DYLD_LIBRARY_PATH: "/tmp", GGML_BACKEND_PATH: "/tmp/evil.so", ANEFORGE_DYLIB: "/tmp/evil.dylib", NODE_OPTIONS: "--require /tmp/evil.js" };
    Object.assign(process.env, planted);
    try {
      expect(buildWorkerEnv({ ...planted, HOME: "/Users/me", TMPDIR: "/tmp/", LANG: "he_IL.UTF-8", PATH: "/tmp/evil" }))
        .toEqual({ HOME: "/Users/me", TMPDIR: "/tmp/", LANG: "he_IL.UTF-8", PATH: "/usr/bin:/bin" });
      const research = new TranscriptionService({
        binaryPaths: { resourcesBasePath: modelPath, whispercppWorkerBinaryPath: process.execPath, ytDlpBinaryPath: "", denoBinaryPath: "" },
        workerEnv: { MELULI_RESEARCH_BEAM: "3" },
        getModelPath: async () => modelPath
      }, { getSettings: () => appSettingsSchema.parse({ modelState: { filePath: modelPath, status: "ready" } }) } as SettingsService);
      const warmup = research.prewarm();
      await flush();
      const { env } = spawnMock.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv };
      expect(env).toMatchObject({ PATH: "/usr/bin:/bin", MELULI_RESEARCH_BEAM: "3" });
      for (const key of Object.keys(planted)) expect(env).not.toHaveProperty(key);
      research.dispose();
      await warmup.catch(() => undefined);
    } finally {
      for (const key of Object.keys(planted)) delete process.env[key];
    }
  });

  describe("job deadline", () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const minutes = (count: number) => count * 60_000;

    async function startJob(input: { sourceType: "imported_file" | "youtube"; durationMs?: number }) {
      const job = service.transcribe({ wavPath: "/tmp/long.wav", ...input });
      reply({ type: "ready", protocolVersion: 2, workerVersion: "test", backend: "whispercpp", capabilities: { vad: { supported: false, mode: "none", requiresModelPath: false } } });
      await vi.waitFor(() => { expect(requests.some((item) => item.type === "transcribe")).toBe(true); });
      return { job, jobId: requests.find((item) => item.type === "transcribe")!.jobId! };
    }

    it.each([
      ["an imported file, whose length is unknown", { sourceType: "imported_file" as const }, minutes(10)],
      ["a two hour link", { sourceType: "youtube" as const, durationMs: minutes(120) }, minutes(20)]
    ])("keeps %s running for as long as the worker reports progress", async (_name, input, limit) => {
      const { job, jobId } = await startJob(input);
      for (let round = 0; round < 6; round += 1) {
        vi.advanceTimersByTime(limit - minutes(1));
        reply({ type: "progress", jobId, stage: "processing", progressRatio: round / 6 });
        await settle();
      }
      expect(child.kill).not.toHaveBeenCalled();
      reply({ type: "result", jobId, result: { text: "שלום", language: "he", segments: [] } });
      await expect(job).resolves.toMatchObject({ text: "שלום" });
    });

    it.each([
      ["with no length", { sourceType: "imported_file" as const }, minutes(10)],
      ["with a long length", { sourceType: "youtube" as const, durationMs: minutes(120) }, minutes(20)]
    ])("ends a job %s when the worker goes silent", async (_name, input, limit) => {
      const { job, jobId } = await startJob(input);
      const failed = expect(job).rejects.toThrow(he.transcriptionProcessFailed);
      reply({ type: "progress", jobId, stage: "processing", progressRatio: 0.1 });
      await settle();
      vi.advanceTimersByTime(limit);
      await failed;
      expect(child.kill).toHaveBeenCalled();
    });

    it("does not count progress from another job", async () => {
      const { job } = await startJob({ sourceType: "imported_file" });
      const failed = expect(job).rejects.toThrow(he.transcriptionProcessFailed);
      vi.advanceTimersByTime(minutes(9));
      reply({ type: "progress", jobId: "someone-else", stage: "processing" });
      await settle();
      vi.advanceTimersByTime(minutes(1));
      await failed;
    });
  });

  it("gives a call piece up to dictation that starts recording", async () => {
    const piece = service.transcribeBackground({ wavPath: "/tmp/piece.wav", sourceType: "call", durationMs: 1000 });
    reply({ type: "ready", protocolVersion: 2, workerVersion: "test", backend: "whispercpp", capabilities: { vad: { supported: false, mode: "none", requiresModelPath: false } } });
    await vi.waitFor(() => { expect(requests.some((item) => item.type === "transcribe")).toBe(true); });
    const request = requests.find((item) => item.type === "transcribe") as Request & { repairText?: boolean };
    expect(request.repairText).toBe(true);

    service.setRecordingActive(true);
    await vi.waitFor(() => { expect(requests.some((item) => item.type === "cancel")).toBe(true); });
    reply({ type: "canceled", jobId: request.jobId });
    await expect(piece).rejects.toThrow(he.transcriptionCanceled);
    await expect(service.transcribeBackground({ wavPath: "/tmp/piece.wav", sourceType: "call" })).rejects.toThrow(he.transcriptionCanceled);
    service.setRecordingActive(false);
  });

  it("waits for a canceled call piece before a foreground job starts", async () => {
    const piece = service.transcribeBackground({ wavPath: "/tmp/piece.wav", sourceType: "call", durationMs: 1000 });
    reply({ type: "ready", protocolVersion: 2, workerVersion: "test", backend: "whispercpp", capabilities: { vad: { supported: false, mode: "none", requiresModelPath: false } } });
    await vi.waitFor(() => { expect(requests.some((item) => item.type === "transcribe")).toBe(true); });
    const first = requests.find((item) => item.type === "transcribe")!;

    const dictation = service.transcribe({ wavPath: "/tmp/dictation.wav", sourceType: "microphone", durationMs: 1000 });
    await vi.waitFor(() => { expect(requests.some((item) => item.type === "cancel")).toBe(true); });
    reply({ type: "canceled", jobId: first.jobId });
    await expect(piece).rejects.toThrow(he.transcriptionCanceled);
    await vi.waitFor(() => { expect(requests.filter((item) => item.type === "transcribe")).toHaveLength(2); });
    const second = requests.filter((item) => item.type === "transcribe")[1]!;
    expect("repairText" in second).toBe(false);
    reply({ type: "result", jobId: second.jobId, result: { text: "שלום", language: "he", segments: [] } });
    await expect(dictation).resolves.toMatchObject({ text: "שלום" });
  });
});
