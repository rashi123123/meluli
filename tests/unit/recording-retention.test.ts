/* @vitest-environment node */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { appSettingsSchema } from "@shared/schemas";
import { AppRuntime } from "@main/runtime";
import { RecordingAudioStore } from "@main/services/recording-audio-store";
import { TranscriptionCanceledError } from "@main/services/transcription-errors";
import { TranscriptionWorkflowService } from "@main/services/transcription-workflow.service";

const buildRecord = vi.hoisted(() => vi.fn());
vi.mock("@main/services/transcript-record", () => ({ buildTranscriptRecord: buildRecord }));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  Notification: { isSupported: () => false }
}));

const RECORDING = "11111111-2222-4333-8444-555555555555";

describe("recording audio retention", () => {
  let directory: string;
  let runtime: AppRuntime;
  let store: RecordingAudioStore;
  let settings: ReturnType<typeof appSettingsSchema.parse>;
  let created: Array<{ id: string }>;
  let transcribe: ReturnType<typeof vi.fn>;
  let replaceTranscription: ReturnType<typeof vi.fn>;
  let getById: ReturnType<typeof vi.fn>;
  let insert: ReturnType<typeof vi.fn>;
  let nextId = 0;

  const record = () => ({
    id: `tx-${++nextId}`, createdAt: 100, sourceType: "microphone" as const, text: "שלום", rawText: "שלום",
    paragraphs: ["שלום"], importedFileName: null, sourceTitle: null, sourceUrl: null, possibleTerms: null,
    uncertainSegments: null, durationMs: 1000, modelId: "model", language: "he", segments: [{ start: 0, end: 1, text: "שלום" }]
  });

  const workflow = () => new TranscriptionWorkflowService({
    database: {
      transcriptRepository: { create: (row: { id: string }) => { created.push(row); return row; }, replaceTranscription, getById },
      paths: { transcriptsDir: join(directory, "transcripts"), userDataPath: directory }
    } as never,
    runtime,
    settingsService: { getSettings: () => settings, setSetting: vi.fn() } as never,
    audioConverter: {} as never,
    transcriptionService: { transcribe, cancel: vi.fn(() => true) } as never,
    textInsertionService: { insertIntoCapturedTarget: insert, clearTargetApplication: vi.fn() } as never,
    showMainWindow: vi.fn(),
    recordings: store
  });
  const payload = () => ({ pcm: new Float32Array(16_000).fill(0.1), sampleRate: 16_000, durationMs: 1000, recordingId: RECORDING });

  beforeEach(() => {
    buildRecord.mockReset().mockImplementation(record);
    directory = mkdtempSync(join(tmpdir(), "meluli-retention-"));
    runtime = new AppRuntime();
    store = new RecordingAudioStore(join(directory, "recordings"));
    settings = appSettingsSchema.parse({});
    created = [];
    transcribe = vi.fn(async () => ({ text: "שלום", language: "he", segments: [] }));
    replaceTranscription = vi.fn((id: string, row: object) => ({ ...row, id, createdAt: 1 }));
    getById = vi.fn(() => null);
    insert = vi.fn(async () => true);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("keeps the audio of a transcribed dictation beside its transcript", async () => {
    await store.append(RECORDING, 0, 16_000, new Float32Array(16_000));
    const transcript = await workflow().transcribeRecordingAudio(payload());
    expect(await store.list()).toEqual([expect.objectContaining({ id: RECORDING, status: "kept", transcriptId: transcript.id })]);
    expect(readdirSync(join(directory, "recordings")).sort()).toEqual([`${RECORDING}.json`, `${RECORDING}.wav`]);
    expect(readdirSync(directory).filter((name) => name.endsWith(".wav"))).toEqual([]);
  });

  it("keeps nothing of a transcribed dictation when keeping is off", async () => {
    settings = { ...settings, keepRecordingAudio: false };
    await store.append(RECORDING, 0, 16_000, new Float32Array(16_000));
    await workflow().transcribeRecordingAudio(payload());
    expect(await store.list()).toEqual([]);
    expect(readdirSync(join(directory, "recordings"))).toEqual([]);
  });

  it("keeps a failed dictation even when keeping is off", async () => {
    settings = { ...settings, keepRecordingAudio: false };
    transcribe.mockRejectedValue(new Error("worker died"));
    await expect(workflow().transcribeRecordingAudio(payload())).rejects.toThrow("worker died");
    expect(await store.list()).toEqual([expect.objectContaining({ id: RECORDING, status: "failed", transcriptId: null })]);
  });

  it("throws away a canceled dictation", async () => {
    await store.append(RECORDING, 0, 16_000, new Float32Array(16_000));
    transcribe.mockRejectedValue(new TranscriptionCanceledError());
    await expect(workflow().transcribeRecordingAudio(payload())).rejects.toThrow();
    expect(readdirSync(join(directory, "recordings"))).toEqual([]);
  });

  it("keeps a dictation the app was quitting through", async () => {
    const service = workflow();
    let finish!: () => void;
    transcribe.mockImplementation(() => new Promise((_resolve, reject) => { finish = () => reject(new TranscriptionCanceledError()); }));
    const pending = service.transcribeRecordingAudio(payload()).catch(() => undefined);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    const disposing = service.dispose();
    finish();
    await Promise.all([pending, disposing]);
    expect(await store.list()).toEqual([expect.objectContaining({ id: RECORDING, status: "failed" })]);
  });

  it("transcribes a failed recording into a new transcript without pasting it", async () => {
    transcribe.mockRejectedValueOnce(new Error("worker died"));
    const service = workflow();
    await expect(service.transcribeRecordingAudio(payload())).rejects.toThrow();
    runtime.updateState({ status: "idle" });
    runtime.startOverlaySession("Safari");
    const sent = vi.spyOn(runtime, "send");

    const { transcript, replaced } = await service.transcribeStoredRecording(RECORDING);
    expect(replaced).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledWith(IPC_CHANNELS.transcriptionComplete, { transcript });
    expect(await store.get(RECORDING)).toMatchObject({ status: "kept", transcriptId: transcript.id });
    expect(runtime.getState().overlaySession?.phase).not.toBe("processing");
  });

  it("repairs model text only when a stored recording is transcribed again, never for dictation", async () => {
    transcribe.mockRejectedValueOnce(new Error("invalid text"));
    const service = workflow();
    await expect(service.transcribeRecordingAudio(payload())).rejects.toThrow();
    runtime.updateState({ status: "idle" });
    await service.transcribeStoredRecording(RECORDING);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[0]![1]).not.toHaveProperty("repairText");
    expect(transcribe.mock.calls[1]![1]).toMatchObject({ repairText: true });
  });

  it("replaces the transcript of a kept recording in place", async () => {
    const first = await workflow().transcribeRecordingAudio(payload());
    getById.mockReturnValue(first);
    const sent = vi.spyOn(runtime, "send");
    const { transcript, replaced } = await workflow().transcribeStoredRecording(RECORDING);
    expect(replaced).toBe(true);
    expect(transcript.id).toBe(first.id);
    expect(replaceTranscription).toHaveBeenCalledWith(first.id, expect.any(Object));
    expect(sent).not.toHaveBeenCalledWith(IPC_CHANNELS.transcriptionComplete, expect.anything());
    expect(created).toHaveLength(1);
  });

  it("refuses while something else is recording or running", async () => {
    await workflow().transcribeRecordingAudio(payload());
    runtime.updateState({ status: "recording" });
    await expect(workflow().transcribeStoredRecording(RECORDING)).rejects.toThrow();
  });
});
