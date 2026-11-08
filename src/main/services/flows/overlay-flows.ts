// The flow step of a dictation: which flow the overlay runs, the preview that waits for the user, and the
// revert that puts the spoken text back. Kept per overlay session by TranscriptionWorkflowService.
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { flowForApp } from "@shared/flows";
import type { OverlaySession, TranscriptRecord } from "@shared/types";
import type { AppDatabase } from "../../db/database";
import type { AppRuntime } from "../../runtime";
import type { FlowService } from "./flow.service";
import type { SettingsService } from "../settings.service";
import type { TextInsertionService } from "../insertion/text-insertion.service";

export type FlowPreviewChoice = "result" | "original";

export interface OverlayFlowsDependencies {
  database: AppDatabase;
  runtime: AppRuntime;
  settingsService: SettingsService;
  textInsertionService: TextInsertionService;
  flows?: Pick<FlowService, "run">;
  /** The pasted copy's shaping for the captured app (terminal, chat), as the dictation's paste had it. */
  shapeForTarget: (text: string) => string;
}

export class OverlayFlows {
  private running: AbortController | null = null;
  /** The dictation a pasted flow result replaced, kept until the next dictation for a revert. */
  private revertable: { sessionId: string; transcriptId: string; text: string } | null = null;
  private preview: { sessionId: string; settle: (choice: FlowPreviewChoice | "cancel") => void; done: Promise<void> } | null = null;

  constructor(private readonly dependencies: OverlayFlowsDependencies) {}

  /** Stops the provider call of a running flow, if any. */
  abort(): void {
    this.running?.abort();
  }

  /** A waiting preview pastes the dictation as spoken. True when one was waiting. */
  declinePreview(): boolean {
    if (!this.preview) return false;
    this.preview.settle("original");
    return true;
  }

  /** Chooses the flow for the dictation being recorded, by the app it will be pasted into. */
  route(): void {
    this.revertable = null;
    const flows = this.dependencies.settingsService.getSettings().flows.filter((flow) => flow.enabled);
    if (!this.dependencies.flows || flows.length === 0) return;
    const routed = flowForApp(flows, this.dependencies.textInsertionService.getCapturedTargetBundleId());
    this.dependencies.runtime.updateOverlaySession({
      flowId: routed?.id ?? null,
      flowChoices: flows.map(({ id, name, icon }) => ({ id, name, icon }))
    });
  }

  /** The overlay picker. It can change the flow until the flow starts. */
  choose(flowId: string | null): boolean {
    const session = this.dependencies.runtime.getState().overlaySession;
    if (!session || session.flowStatus || (session.phase !== "recording" && session.phase !== "processing")) return false;
    if (flowId !== null && !session.flowChoices?.some((choice) => choice.id === flowId)) return false;
    this.dependencies.runtime.updateOverlaySession({ flowId });
    return true;
  }

  /** Resolves a waiting preview. The promise settles once the paste it started is over. */
  choosePreview(choice: FlowPreviewChoice): Promise<void> | null {
    const preview = this.preview;
    if (!preview) return null;
    preview.settle(choice);
    return preview.done;
  }

  isPreviewPending(): boolean {
    return this.preview !== null;
  }

  /** A failed or unready flow still delivers the dictation: it is never lost to a provider problem. */
  async apply(transcript: TranscriptRecord, session: OverlaySession, pasteDone: Promise<void>): Promise<string> {
    const runner = this.dependencies.flows;
    const flow = session.flowId ? this.dependencies.settingsService.getSettings().flows.find((f) => f.id === session.flowId) : undefined;
    if (!runner || !flow || !transcript.text.trim()) return transcript.text;
    const run = new AbortController();
    this.running = run;
    this.dependencies.runtime.updateOverlaySession({ flowStatus: "running" });
    try {
      const { result } = await runner.run(flow, transcript.text, run.signal);
      if (!result.ok) {
        this.dependencies.runtime.updateOverlaySession({ flowStatus: "failed", flowFailure: result.reason });
        return transcript.text;
      }
      if (flow.delivery === "preview") {
        let settle!: (choice: FlowPreviewChoice | "cancel") => void;
        const choice = new Promise<FlowPreviewChoice | "cancel">((resolve) => { settle = resolve; });
        this.preview = { sessionId: session.id, settle, done: pasteDone };
        this.dependencies.runtime.updateOverlaySession({ flowStatus: "preview", transcriptText: result.text });
        const chosen = await choice;
        this.preview = null;
        if (chosen !== "result") {
          this.dependencies.runtime.updateOverlaySession({ flowStatus: "reverted", transcriptText: transcript.text });
          return transcript.text;
        }
      }
      const updated = this.dependencies.database.transcriptRepository.applyFlow(transcript.id, result.text, flow.name);
      if (updated) this.dependencies.runtime.send(IPC_CHANNELS.transcriptionComplete, { transcript: updated });
      if (flow.delivery === "paste") this.revertable = { sessionId: session.id, transcriptId: transcript.id, text: transcript.text };
      this.dependencies.runtime.updateOverlaySession({ flowStatus: "applied" });
      return result.text;
    } finally {
      this.running = null;
      this.preview = null;
    }
  }

  /** Puts the dictation back in place of the pasted result, or offers it to copy when that cannot be proven safe. */
  async revert(): Promise<void> {
    const session = this.dependencies.runtime.getState().overlaySession;
    const raw = this.revertable;
    if (!session || session.phase !== "success" || session.flowStatus !== "applied" || raw?.sessionId !== session.id) return;
    this.revertable = null;
    const replaced = await this.dependencies.textInsertionService.replaceLastInsertion(raw.text, this.dependencies.shapeForTarget).catch(() => false);
    const restored = this.dependencies.database.transcriptRepository.restoreOriginal(raw.transcriptId);
    if (restored) this.dependencies.runtime.send(IPC_CHANNELS.transcriptionComplete, { transcript: restored });
    this.dependencies.runtime.updateOverlaySession({ flowStatus: replaced ? "reverted" : "copy_raw", transcriptText: raw.text });
  }
}
