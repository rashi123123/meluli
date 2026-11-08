/* @vitest-environment node */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSettingsSchema } from "@shared/schemas";
import type { Flow, FlowRunOutcome } from "@shared/flows";
import { AppRuntime } from "@main/runtime";
import { TranscriptionWorkflowService } from "@main/services/transcription-workflow.service";

const buildRecord = vi.hoisted(() => vi.fn());
vi.mock("@main/services/transcript-record", () => ({ buildTranscriptRecord: buildRecord }));
vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: () => null }, Notification: { isSupported: () => false } }));

const transcript = {
  id: "tx-1", createdAt: 1, sourceType: "microphone" as const, text: "תכתוב לדנה שאני מאחר", rawText: "תכתוב לדנה שאני מאחר",
  paragraphs: ["תכתוב לדנה שאני מאחר"], importedFileName: null, sourceTitle: null, sourceUrl: null, possibleTerms: null,
  uncertainSegments: null, durationMs: 1_500, modelId: "model", language: "he", segments: [{ start: 0, end: 1.5, text: "תכתוב לדנה שאני מאחר" }]
};
const mail = { bundleId: "com.apple.mail", name: "Mail" };
const flowFor = (delivery: Flow["delivery"]): Flow => ({
  id: "email", name: "מייל", icon: "envelope", apps: [mail], delivery, enabled: true,
  steps: [{ id: "s1", kind: "llm", instruction: "נסח מייל", connectionId: null }]
});
const ok = (text: string): FlowRunOutcome => ({ result: { ok: true, text }, trace: [] });

describe("flows in the dictation workflow", () => {
  let directory: string;
  let runtime: AppRuntime;
  let flows: { run: ReturnType<typeof vi.fn> };
  let insertion: Record<string, ReturnType<typeof vi.fn>>;
  let repository: Record<string, ReturnType<typeof vi.fn>>;

  const setup = (delivery: Flow["delivery"]) => {
    const settings = appSettingsSchema.parse({ onboardingCompleted: true, flows: [flowFor(delivery)] });
    const workflow = new TranscriptionWorkflowService({
      database: { transcriptRepository: repository, paths: { transcriptsDir: join(directory, "t"), userDataPath: directory } } as never,
      runtime,
      settingsService: { getSettings: () => settings, setSetting: vi.fn() } as never,
      audioConverter: {} as never,
      transcriptionService: {
        transcribe: vi.fn(async () => ({ text: transcript.text, language: "he", segments: transcript.segments })),
        cancel: vi.fn(() => false)
      } as never,
      textInsertionService: insertion as never,
      showMainWindow: vi.fn(),
      flows: flows as never
    });
    workflow.routeOverlayFlow();
    return workflow;
  };
  const dictate = (workflow: TranscriptionWorkflowService) => workflow.transcribeAndStore({ wavPath: "/tmp/public-fixture.wav", sourceType: "microphone" });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meluli-flows-"));
    buildRecord.mockReset().mockImplementation(() => transcript);
    runtime = new AppRuntime();
    runtime.startOverlaySession("Mail");
    flows = { run: vi.fn(async () => ok("היי דנה, אאחר מעט.")) };
    insertion = {
      insertIntoCapturedTarget: vi.fn(async () => true),
      clearTargetApplication: vi.fn(),
      getCapturedTargetBundleId: vi.fn(() => mail.bundleId),
      replaceLastInsertion: vi.fn(async () => true)
    };
    repository = {
      create: vi.fn(),
      applyFlow: vi.fn(() => ({ ...transcript, text: "היי דנה, אאחר מעט.", flowName: "מייל" })),
      restoreOriginal: vi.fn(() => transcript)
    };
  });

  it("routes the dictation by the target app and pastes the result", async () => {
    const workflow = setup("paste");
    expect(runtime.getState().overlaySession).toMatchObject({ flowId: "email", flowChoices: [{ id: "email", name: "מייל", icon: "envelope" }] });
    await dictate(workflow);
    expect(insertion.insertIntoCapturedTarget).toHaveBeenCalledWith("היי דנה, אאחר מעט.");
    expect(repository.applyFlow).toHaveBeenCalledWith("tx-1", "היי דנה, אאחר מעט.", "מייל");
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "success", flowStatus: "applied" });
  });

  it("pastes the dictation as spoken when the flow fails", async () => {
    flows.run.mockResolvedValueOnce({ result: { ok: false, reason: "auth" }, trace: [] });
    await dictate(setup("paste"));
    expect(insertion.insertIntoCapturedTarget).toHaveBeenCalledWith(transcript.text);
    expect(repository.applyFlow).not.toHaveBeenCalled();
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "success", flowStatus: "failed", flowFailure: "auth" });
  });

  it("runs no flow when the overlay picks none", async () => {
    const workflow = setup("paste");
    expect(workflow.chooseOverlayFlow(null)).toBe(true);
    await dictate(workflow);
    expect(flows.run).not.toHaveBeenCalled();
    expect(insertion.insertIntoCapturedTarget).toHaveBeenCalledWith(transcript.text);
  });

  it("refuses a flow the overlay was not offered", () => {
    expect(setup("paste").chooseOverlayFlow("other")).toBe(false);
  });

  it("puts the original back in place of the result", async () => {
    const workflow = setup("paste");
    await dictate(workflow);
    await workflow.revertFlow();
    expect(insertion.replaceLastInsertion).toHaveBeenCalledWith(transcript.text, expect.any(Function));
    expect(repository.restoreOriginal).toHaveBeenCalledWith("tx-1");
    expect(runtime.getState().overlaySession).toMatchObject({ flowStatus: "reverted", transcriptText: transcript.text });
  });

  it("shapes the reverted original for the target it lands in, as one line in a terminal", async () => {
    const workflow = setup("paste");
    await dictate(workflow);
    insertion.getCapturedTargetBundleId!.mockReturnValue("com.apple.Terminal");
    await workflow.revertFlow();
    const shape = insertion.replaceLastInsertion!.mock.calls[0]![1] as (text: string) => string;
    expect(shape("שורה ראשונה\nשורה שנייה")).toBe("שורה ראשונה שורה שנייה");
  });

  it("offers the original to copy when it cannot be put back safely", async () => {
    insertion.replaceLastInsertion!.mockResolvedValueOnce(false);
    const workflow = setup("paste");
    await dictate(workflow);
    await workflow.revertFlow();
    expect(runtime.getState().overlaySession).toMatchObject({ flowStatus: "copy_raw", transcriptText: transcript.text });
  });

  it("waits on a preview, and pastes the result on the dictation key", async () => {
    const workflow = setup("preview");
    const done = dictate(workflow);
    await vi.waitFor(() => expect(workflow.isFlowPreviewPending()).toBe(true));
    expect(runtime.getState().overlaySession).toMatchObject({ flowStatus: "preview", transcriptText: "היי דנה, אאחר מעט." });
    expect(insertion.insertIntoCapturedTarget).not.toHaveBeenCalled();
    const pasted = workflow.chooseFlowPreview("result");
    await done; await pasted;
    expect(insertion.insertIntoCapturedTarget).toHaveBeenCalledWith("היי דנה, אאחר מעט.");
    // A preview has no revert: the user already chose.
    await workflow.revertFlow();
    expect(insertion.replaceLastInsertion).not.toHaveBeenCalled();
  });

  it("pastes the original when Esc answers a preview, without canceling the dictation", async () => {
    const workflow = setup("preview");
    const done = dictate(workflow);
    await vi.waitFor(() => expect(workflow.isFlowPreviewPending()).toBe(true));
    expect(workflow.cancelActiveTranscription()).toBe(false);
    await done;
    expect(insertion.insertIntoCapturedTarget).toHaveBeenCalledWith(transcript.text);
    expect(repository.applyFlow).not.toHaveBeenCalled();
    expect(runtime.getState().overlaySession).toMatchObject({ phase: "success", flowStatus: "reverted" });
  });
});
