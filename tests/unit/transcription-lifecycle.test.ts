/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_WEIGHT_FILE } from "@shared/constants";
import { he } from "@shared/locale";
import { appSettingsSchema } from "@shared/schemas";
import { MODEL_IDLE_TIMEOUT_MS, TranscriptionService } from "@main/services/transcription.service";
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

  it("cancels while waiting for startup and settles every pending promise", async () => {
    const transcription = service.transcribe({ wavPath: "/fixture.wav", sourceType: "microphone", durationMs: 1000 });
    const canceled = expect(transcription).rejects.toMatchObject({ name: "TranscriptionCanceledError" });
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
