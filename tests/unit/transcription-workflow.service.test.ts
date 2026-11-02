/* @vitest-environment node */
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptionCanceledError } from "@main/services/transcription.service";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { he } from "@shared/locale";
import { appSettingsSchema } from "@shared/schemas";
import { AppRuntime } from "@main/runtime";
import { TranscriptionWorkflowService } from "@main/services/transcription-workflow.service";
import { TextInsertionError } from "@main/services/text-insertion.service";

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => null
  },
  Notification: {
    isSupported: () => false
  }
}));

const baseSettings = appSettingsSchema.parse({
  onboardingCompleted: true,
  shortcut: "Control+Shift+R",
  overlayShortcut: "Control+Shift+H",
  microphoneDeviceId: null,
  completionNotificationsEnabled: false,
  metalEnabled: true,
  launchAtLogin: false,
  speedPreference: "balanced" as const,
  removeFillerWords: false,
  processingTelemetry: {
    microphone: {
      balanced: { sampleCount: 0, averageSetupMs: 7_000, averageMsPerAudioSecond: 200 },
      accurate: { sampleCount: 0, averageSetupMs: 7_800, averageMsPerAudioSecond: 224 }
    },
    imported_file: {
      balanced: { sampleCount: 0, averageSetupMs: 6_500, averageMsPerAudioSecond: 180 },
      accurate: { sampleCount: 0, averageSetupMs: 7_200, averageMsPerAudioSecond: 202 }
    },
    youtube: {
      balanced: { sampleCount: 0, averageSetupMs: 6_500, averageMsPerAudioSecond: 180 },
      accurate: { sampleCount: 0, averageSetupMs: 7_200, averageMsPerAudioSecond: 202 }
    }
  },
  modelState: {
    id: "model",
    url: "https://example.com/model",
    fileName: "model",
    filePath: "/tmp/model",
    downloadState: "ready" as const,
    bytesDownloaded: 0,
    totalBytes: null,
    lastError: null
  }
});

describe("TranscriptionWorkflowService overlay session flow", () => {
  const transcript = {
    id: "tx-1",
    createdAt: 123,
    sourceType: "microphone" as const,
    text: "שלום עולם",
    rawText: "שלום עולם",
    paragraphs: ["שלום עולם"],
    importedFileName: null,
    sourceTitle: null,
    sourceUrl: null,
    possibleTerms: null,
    uncertainSegments: null,
    durationMs: 1_500,
    modelId: "model",
    language: "he",
    segments: [{ start: 0, end: 1.5, text: "שלום עולם" }]
  };

  let directory: string;
  let runtime: AppRuntime;
  let database: {
    transcriptRepository: { create: ReturnType<typeof vi.fn> };
    paths: { transcriptsDir: string; userDataPath: string };
  };
  let settingsService: {
    getSettings: ReturnType<typeof vi.fn>;
    setSetting: ReturnType<typeof vi.fn>;
  };
  let transcriptionService: {
    transcribe: ReturnType<typeof vi.fn>;
    buildTranscriptRecord: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  let textInsertionService: {
    insertIntoCapturedTarget: ReturnType<typeof vi.fn>;
    clearTargetApplication: ReturnType<typeof vi.fn>;
  };

  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meluli-workflow-"));
    runtime = new AppRuntime();
    runtime.startOverlaySession("Safari");
    database = {
      transcriptRepository: {
        create: vi.fn()
      },
      paths: {
        transcriptsDir: join(directory, "transcripts"),
        userDataPath: directory
      }
    };
    settingsService = {
      getSettings: vi.fn(() => baseSettings),
      setSetting: vi.fn()
    };
    transcriptionService = {
      transcribe: vi.fn(async () => ({
        text: transcript.text,
        language: "he",
        segments: transcript.segments
      })),
      buildTranscriptRecord: vi.fn(() => transcript),
      cancel: vi.fn(() => true)
    };
    textInsertionService = {
      insertIntoCapturedTarget: vi.fn(async () => true),
      clearTargetApplication: vi.fn()
    };
  });

  it.each([false, true])("settles prepared-ASR failure without a transcript or insertion (canceled=%s)", canceled => {
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime,
      settingsService: settingsService as never, audioConverter: {} as never,
      transcriptionService: transcriptionService as never, textInsertionService: textInsertionService as never,
      showMainWindow: vi.fn() });
    runtime.updateState({status:"processing",activeSourceType:"microphone",processingStartedAt:123});
    workflow.failPreparedRecording(canceled ? new TranscriptionCanceledError() : new Error("worker failed"));
    expect(runtime.getState().status).toBe(canceled ? "idle" : "error");
    expect(runtime.getState().processingStartedAt).toBeNull();
    expect(runtime.getState().overlaySession).toBeNull();
    expect(database.transcriptRepository.create).not.toHaveBeenCalled();
    expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
    expect(textInsertionService.clearTargetApplication).toHaveBeenCalledOnce();
  });

  it("keeps the stored transcript but dispatches nothing when canceled while a research reservation is pending", async () => {
    let release!: (value: boolean) => void;
    const journal = { claim: vi.fn(() => new Promise<boolean>(resolve => { release = resolve; })), attachRecovery: vi.fn(async () => {}), settle: vi.fn(async () => {}) };
    transcriptionService.cancel.mockReturnValue(false);
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime,
      settingsService: settingsService as never, audioConverter: {} as never,
      transcriptionService: transcriptionService as never, textInsertionService: textInsertionService as never,
      showMainWindow: vi.fn(), insertionJournal: journal as never });
    const operation = workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone", durationMs: 1500 });
    await vi.waitFor(() => expect(database.transcriptRepository.create).toHaveBeenCalledOnce());
    expect(workflow.cancelActiveTranscription()).toBe(true);
    release(true); await operation;
    expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
    expect(journal.settle).toHaveBeenCalledWith(expect.any(String), transcript.id, "not_dispatched");
    expect(runtime.getState().overlaySession?.manualCopyOnly).toBe(true);
  });

  it("keeps the stored transcript but dispatches nothing when production is canceled before insertion", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finish = transcriptionService.transcribe.getMockImplementation()!;
    transcriptionService.transcribe.mockImplementationOnce(async (...args: unknown[]) => { await gate; return finish(...args); });
    transcriptionService.cancel.mockReturnValue(false);
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: textInsertionService as never, showMainWindow: vi.fn() });
    const operation = workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    await vi.waitFor(() => expect(transcriptionService.transcribe).toHaveBeenCalledOnce());
    expect(workflow.cancelActiveTranscription()).toBe(true);
    release(); await operation;
    expect(database.transcriptRepository.create).toHaveBeenCalledOnce();
    expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "paste_failed", manualCopyOnly: true, insertionOutcome: "not_dispatched" });
  });

  it.each(["unresolved", "not_dispatched", "command_completed_unverified"] as const)("retains source recovery and distinguishes %s without automatic retry", async outcome => {
    const journal = { claim: vi.fn(async () => true), attachRecovery: vi.fn(async () => {}), settle: vi.fn(async () => {}) };
    const insertion = { ...textInsertionService, getRecoveryTargetMetadata: () => ({ pid: 2, bundleId: "local.editor" }),
      getLastInsertionOutcome: () => outcome,
      insertIntoCapturedTarget: vi.fn(async () => { if (outcome !== "command_completed_unverified") throw new TextInsertionError("paste_failed", "inspect"); return true; }) };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: insertion as never,
      showMainWindow: vi.fn(), researchArchive: true, insertionJournal: journal as never });
    await workflow.transcribeAndStore({ wavPath: "/research/original.wav", sourceType: "microphone" });
    expect(database.transcriptRepository.create).toHaveBeenCalledOnce();expect(insertion.insertIntoCapturedTarget).toHaveBeenCalledOnce();
    expect(journal.attachRecovery).toHaveBeenCalledWith(expect.any(String), transcript.id, expect.objectContaining({audioPath:"/research/original.wav",transcriptText:transcript.text,target:{pid:2,bundleId:"local.editor"}}));
    expect(runtime.getState().overlaySession).toMatchObject({manualCopyOnly:true,phase:"paste_failed",insertionOutcome:outcome==="not_dispatched"?"not_dispatched":"unknown"});
    expect(journal.attachRecovery.mock.invocationCallOrder[0]).toBeLessThan(insertion.insertIntoCapturedTarget.mock.invocationCallOrder[0]);
  });

  it("finishes without pasting when the user dictated with Meluli itself in front", async () => {
    const insertion = { ...textInsertionService, isOwnWindowTarget: () => true };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: insertion as never, showMainWindow: vi.fn() });
    await workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    expect(insertion.insertIntoCapturedTarget).not.toHaveBeenCalled();
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "success", deliveredInApp: true, transcriptText: transcript.text, lastErrorCode: null });
    expect(insertion.clearTargetApplication).toHaveBeenCalledOnce();
  });

  it.each([[true, { manualCopyOnly: true, insertionOutcome: "unknown" }], [false, {}]] as const)("allows a production retry only when nothing may have reached the target (unknown: %s)", async (unknown, expected) => {
    const insertion = { ...textInsertionService, getLastInsertionOutcome: () => "unresolved", hasUnknownNativeOutcome: () => unknown,
      insertIntoCapturedTarget: vi.fn(async () => { throw new TextInsertionError("paste_failed", "inspect"); }) };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: insertion as never, showMainWindow: vi.fn() });
    await workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    expect(insertion.insertIntoCapturedTarget).toHaveBeenCalledOnce();
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "paste_failed", transcriptText: transcript.text, ...expected });
    if (!unknown) expect(runtime.getState().overlaySession?.manualCopyOnly).toBeUndefined();
  });

  it.each([[true, { manualCopyOnly: true, insertionOutcome: "unknown" }], [false, {}]] as const)("records a failed manual retry so it cannot be repeated blindly (unknown: %s)", async (unknown, expected) => {
    let outcomeUnknown = false;
    const insertion = { ...textInsertionService, getLastInsertionOutcome: () => "not_dispatched", hasUnknownNativeOutcome: () => outcomeUnknown,
      insertIntoCapturedTarget: vi.fn(async () => { throw new TextInsertionError("paste_failed", "inspect"); }) };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: insertion as never, showMainWindow: vi.fn() });
    await workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    outcomeUnknown = unknown;
    await expect(workflow.retryPaste(transcript.text)).rejects.toMatchObject({ code: "paste_failed" });
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "paste_failed", ...expected });
    if (!unknown) expect(runtime.getState().overlaySession?.manualCopyOnly).toBeUndefined();
  });

  it("records a blind paste as sent but unconfirmed, and never as inserted", async () => {
    const insertion = { ...textInsertionService, getLastInsertionOutcome: () => "dispatched_unverified" };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: insertion as never, showMainWindow: vi.fn() });
    await workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "success", insertionOutcome: "unverified", transcriptText: transcript.text });
  });

  it.each(["target_unavailable", "secure_field"] as const)("offers only Copy after %s, which no retry could fix", async code => {
    const insertion = { ...textInsertionService, getLastInsertionOutcome: () => "not_dispatched",
      insertIntoCapturedTarget: vi.fn(async () => { throw new TextInsertionError(code, "inspect"); }) };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: insertion as never, showMainWindow: vi.fn() });
    await workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "paste_failed", lastErrorCode: code, manualCopyOnly: true, transcriptText: transcript.text });
  });

  it("asks for the explicit path on a user retry, the only one allowed to bring the target forward", async () => {
    const insert = vi.fn().mockRejectedValueOnce(new TextInsertionError("target_changed", "moved")).mockResolvedValue(true);
    const insertion = { ...textInsertionService, getLastInsertionOutcome: () => "not_dispatched", insertIntoCapturedTarget: insert };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: insertion as never, showMainWindow: vi.fn() });
    await workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "paste_failed", lastErrorCode: "target_changed" });
    expect(insert.mock.calls[0][2]).not.toEqual({ explicit: true });
    await workflow.retryPaste(transcript.text);
    expect(insert).toHaveBeenLastCalledWith(transcript.text, undefined, { explicit: true });
  });

  it("does not report failure after a paste, which would offer pasting it again", async () => {
    const send = vi.spyOn(runtime, "send").mockImplementation(channel => { if (channel === IPC_CHANNELS.transcriptionComplete) throw new Error("window gone"); });
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: textInsertionService as never, showMainWindow: vi.fn() });
    await expect(workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" })).resolves.toMatchObject({ id: transcript.id });
    expect(textInsertionService.insertIntoCapturedTarget).toHaveBeenCalledOnce();
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "success" });
    send.mockRestore();
  });

  it("keeps the transcript and still pastes when the timing sample cannot be saved", async () => {
    settingsService.setSetting.mockImplementationOnce(() => { throw new Error("disk full"); });
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: textInsertionService as never, showMainWindow: vi.fn() });
    await workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });
    expect(textInsertionService.insertIntoCapturedTarget).toHaveBeenCalledOnce();
  });

  it("blocks external mutation when durable recovery cannot be written", async () => {
    const journal = { claim: vi.fn(async () => true), attachRecovery: vi.fn(async () => { throw new Error("disk unavailable"); }), settle: vi.fn(async () => {}) };
    const workflow = new TranscriptionWorkflowService({ database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: {} as never, transcriptionService: transcriptionService as never, textInsertionService: textInsertionService as never,
      showMainWindow: vi.fn(), insertionJournal: journal as never });
    await workflow.transcribeAndStore({ wavPath:"/research/original.wav", sourceType:"microphone" });
    expect(database.transcriptRepository.create).toHaveBeenCalledOnce();expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
    expect(journal.settle).toHaveBeenCalledWith(expect.any(String),transcript.id,"not_dispatched");
  });
  it("settles an unused research reservation after ASR fails and releases in-memory ownership", async () => {
    const journal = { claim: vi.fn(async () => true), settle: vi.fn(async () => {}), releaseOwnership: vi.fn() };
    transcriptionService.transcribe.mockRejectedValueOnce(new Error("worker failed"));
    const workflow = new TranscriptionWorkflowService({database:database as never,runtime,settingsService:settingsService as never,
      audioConverter:{} as never,transcriptionService:transcriptionService as never,textInsertionService:textInsertionService as never,
      showMainWindow:vi.fn(),insertionJournal:journal as never});
    await expect(workflow.transcribeAndStore({wavPath:"/research/original.wav",sourceType:"microphone"})).rejects.toThrow("worker failed");
    expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
    expect(journal.settle).toHaveBeenCalledWith(expect.any(String),"pending-transcript","not_dispatched");
    expect(journal.releaseOwnership).toHaveBeenCalledOnce();
  });
  it("abandons early reservation on finalization failure before the store workflow begins",async()=>{
    const journal={claim:vi.fn(async()=>true),settle:vi.fn(async()=>{}),releaseOwnership:vi.fn()};
    const workflow=new TranscriptionWorkflowService({database:database as never,runtime,settingsService:settingsService as never,
      audioConverter:{} as never,transcriptionService:transcriptionService as never,textInsertionService:textInsertionService as never,
      showMainWindow:vi.fn(),insertionJournal:journal as never});
    workflow.prepareExperimentalInsertionReservation();await workflow.abandonExperimentalInsertionReservation();
    expect(journal.settle).toHaveBeenCalledWith(expect.any(String),"pending-transcript","not_dispatched");
    expect(journal.releaseOwnership).toHaveBeenCalledOnce();expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
    await workflow.abandonExperimentalInsertionReservation();expect(journal.settle).toHaveBeenCalledOnce();
  });

  it("marks the overlay session successful after auto-paste succeeds", async () => {
    const trayReadyListener = vi.fn();
    runtime.on("tray-ready", trayReadyListener);
    const workflow = new TranscriptionWorkflowService({
      database: database as never,
      runtime,
      settingsService: settingsService as never,
      audioConverter: {} as never,
      transcriptionService: transcriptionService as never,
      textInsertionService: textInsertionService as never,
      showMainWindow: vi.fn()
    });

    await workflow.transcribeAndStore({
      wavPath: "/tmp/input.wav",
      sourceType: "microphone",
      durationMs: 1_500
    });

    expect(textInsertionService.insertIntoCapturedTarget).toHaveBeenCalledWith("שלום עולם");
    expect(database.transcriptRepository.create).toHaveBeenCalledWith(transcript);
    expect(runtime.getState().overlaySession).toEqual(
      expect.objectContaining({
        phase: "success",
        transcriptId: "tx-1",
        transcriptText: "שלום עולם",
        lastErrorCode: null
      })
    );
    expect(trayReadyListener).toHaveBeenCalledTimes(1);
  });

  it("keeps the session open for retry when auto-paste fails", async () => {
    textInsertionService.insertIntoCapturedTarget.mockRejectedValue(
      new TextInsertionError("target_unavailable", he.textInsertionTargetUnavailable)
    );
    const workflow = new TranscriptionWorkflowService({
      database: database as never,
      runtime,
      settingsService: settingsService as never,
      audioConverter: {} as never,
      transcriptionService: transcriptionService as never,
      textInsertionService: textInsertionService as never,
      showMainWindow: vi.fn()
    });

    await workflow.transcribeAndStore({
      wavPath: "/tmp/input.wav",
      sourceType: "microphone",
      durationMs: 1_500
    });

    expect(database.transcriptRepository.create).toHaveBeenCalledWith(transcript);
    expect(runtime.getState().overlaySession).toEqual(
      expect.objectContaining({
        phase: "paste_failed",
        transcriptId: "tx-1",
        transcriptText: "שלום עולם",
        lastErrorCode: "target_unavailable"
      })
    );
  });

  it("clears the overlay session on real transcription failure", async () => {
    transcriptionService.transcribe.mockRejectedValue(new Error("boom"));
    const workflow = new TranscriptionWorkflowService({
      database: database as never,
      runtime,
      settingsService: settingsService as never,
      audioConverter: {} as never,
      transcriptionService: transcriptionService as never,
      textInsertionService: textInsertionService as never,
      showMainWindow: vi.fn()
    });

    await expect(
      workflow.transcribeAndStore({
        wavPath: "/tmp/input.wav",
        sourceType: "microphone",
        durationMs: 1_500
      })
    ).rejects.toThrow("boom");

    expect(runtime.getState().overlaySession).toBeNull();
    expect(textInsertionService.clearTargetApplication).toHaveBeenCalled();
  });
  function createWorkflow(audioConverter = {}): TranscriptionWorkflowService {
    return new TranscriptionWorkflowService({
      database: database as never, runtime, settingsService: settingsService as never,
      audioConverter: audioConverter as never, transcriptionService: transcriptionService as never,
      textInsertionService: textInsertionService as never, showMainWindow: vi.fn()
    });
  }

  it("retains the database result and pastes when the optional TXT mirror cannot be written", async () => {
    writeFileSync(database.paths.transcriptsDir, "not a directory");
    const result = await createWorkflow().transcribeAndStore({ wavPath: "/unused.wav", sourceType: "microphone" });
    expect(result.id).toBe(transcript.id);
    expect(database.transcriptRepository.create).toHaveBeenCalledTimes(1);
    expect(textInsertionService.insertIntoCapturedTarget).toHaveBeenCalledTimes(1);
    expect(runtime.getState().status).toBe("idle");
    expect(runtime.getState().lastError).toContain("TXT");
  });

  it("keeps admission closed until the automatic paste has settled", async () => {
    let finish!: (value: boolean) => void;
    textInsertionService.insertIntoCapturedTarget.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = createWorkflow().transcribeAndStore({ wavPath: "/unused.wav", sourceType: "microphone" });
    await vi.waitFor(() => expect(textInsertionService.insertIntoCapturedTarget).toHaveBeenCalledTimes(1));
    expect(runtime.getState().status).toBe("processing");
    expect(() => runtime.claimRecording(10)).toThrow();
    finish(true);
    await pending;
    expect(runtime.getState().status).toBe("idle");
  });

  it("stores and pastes a prepared experimental final once without calling ASR again", async () => {
    const prepared = { text: "שלום עולם", language: "he", backend: "whispercpp" as const,
      modelId: "model", segments: [{ start: 0, end: 1.5, text: "שלום עולם" }] };
    const completed = await createWorkflow().transcribePreparedRecording(
      { wavPath: "/retained-research-source", sourceType: "microphone", durationMs: 1500 }, prepared
    );
    expect(completed.id).toBe(transcript.id);
    expect(transcriptionService.transcribe).not.toHaveBeenCalled();
    expect(database.transcriptRepository.create).toHaveBeenCalledTimes(1);
    expect(textInsertionService.insertIntoCapturedTarget).toHaveBeenCalledTimes(1);
    expect(runtime.getState().status).toBe("idle");
  });

  it("does not advertise idle before a canceled transcription has actually rejected", async () => {
    let fail!: (error: Error) => void;
    transcriptionService.transcribe.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const workflow = createWorkflow();
    const pending = workflow.transcribeAndStore({ wavPath: "/unused.wav", sourceType: "microphone" });
    const rejected = expect(pending).rejects.toThrow(he.transcriptionCanceled);
    expect(workflow.cancelActiveTranscription()).toBe(true);
    expect(runtime.getState().status).toBe("processing");
    fail(new TranscriptionCanceledError());
    await rejected;
    await workflow.waitForSettled();
    expect(runtime.getState().status).toBe("idle");
    expect(database.transcriptRepository.create).not.toHaveBeenCalled();
    expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
  });

  it("cancels a cold audio encoder before ASR or paste and releases its temporary resources", async () => {
    const workflow = createWorkflow();
    const pending = workflow.transcribeRecordingAudio({ pcm: new Float32Array(16_000), sampleRate: 16_000, durationMs: 1_000 });
    const rejected = expect(pending).rejects.toThrow(he.transcriptionCanceled);
    expect(workflow.cancelActiveTranscription()).toBe(true);
    await rejected;
    await workflow.waitForSettled();
    expect(runtime.getState().status).toBe("idle");
    expect(readdirSync(directory)).toHaveLength(0);
    expect(transcriptionService.transcribe).not.toHaveBeenCalled();
    expect(textInsertionService.insertIntoCapturedTarget).not.toHaveBeenCalled();
  });

  it("cancels file conversion, removes its partial WAV, and never starts ASR", async () => {
    runtime.clearOverlaySession();
    const convertInputToWav = vi.fn((_input: string, output: string, signal: AbortSignal) => {
      writeFileSync(output, "partial audio");
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const workflow = createWorkflow({ convertInputToWav });
    const pending = workflow.transcribeImportedFile("/unused.mp3");
    const rejected = expect(pending).rejects.toThrow(he.transcriptionCanceled);
    expect(runtime.getState().status).toBe("processing");
    expect(() => runtime.claimRecording(10)).toThrow();
    expect(workflow.cancelActiveTranscription()).toBe(true);
    await rejected;
    await workflow.waitForSettled();
    expect(runtime.getState().status).toBe("idle");
    expect(readdirSync(directory)).toHaveLength(0);
    expect(transcriptionService.transcribe).not.toHaveBeenCalled();
  });

  it.each(["idle", "error"] as const)("refuses an import while a recording holds the claim (status %s)", async status => {
    runtime.clearOverlaySession();
    runtime.updateState({ status });
    runtime.claimRecording(10);
    const convertInputToWav = vi.fn();
    await expect(createWorkflow({ convertInputToWav }).transcribeImportedFile("/unused.mp3")).rejects.toThrow("כבר יש הקלטה");
    expect(convertInputToWav).not.toHaveBeenCalled();
    expect(runtime.getState().status).toBe(status);
    expect(runtime.getState().activeSourceType).toBeNull();
  });

  it.each([
    ["finishes", null],
    ["fails", new Error("engine failed")],
    ["is canceled", new TranscriptionCanceledError()]
  ])("leaves the status with a recording that holds the claim when a job %s", async (_name, failure) => {
    runtime.clearOverlaySession();
    runtime.claimRecording(10);
    runtime.updateState({ status: "recording", activeSourceType: "microphone", timerStartedAt: 5 });
    let settle!: () => void;
    transcriptionService.transcribe.mockImplementation(() => new Promise((resolve, reject) => {
      settle = () => failure ? reject(failure) : resolve({ text: transcript.text, language: "he", segments: transcript.segments });
    }));
    const pending = createWorkflow().transcribeAndStore({ wavPath: "/unused.wav", sourceType: "imported_file" });
    const landed = pending.catch(() => undefined);
    await vi.waitFor(() => expect(transcriptionService.transcribe).toHaveBeenCalled());
    expect(runtime.getState()).toMatchObject({ status: "recording", activeSourceType: "microphone", timerStartedAt: 5 });
    settle();
    await landed;
    expect(runtime.getState()).toMatchObject({ status: "recording", activeSourceType: "microphone", timerStartedAt: 5 });
  });

});
