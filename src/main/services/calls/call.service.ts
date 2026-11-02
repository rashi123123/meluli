import { statfs } from "node:fs/promises";
import { callAppById, callAppForBundle, CALL_APPS, type CallApp } from "@shared/call-apps";
import type { AppStateSnapshot, CallNotice, CallState, TranscriptSegment } from "@shared/types";
import type { CallAudioClient, HelperApp } from "./call-audio.client";
import { CallDetector, type AppActivity } from "./call-detector";
import { CallStore, createCallRecord, type CallRecord } from "./call-store";
import { recordedLengthMs, transcribeCall, type PieceTranscriber } from "./call-transcription";

export const MAX_CALL_MS = 4 * 60 * 60_000;
const MIN_FREE_TO_START = 1024 ** 3;
const MIN_FREE_WHILE_RECORDING = 200 * 1024 ** 2;
const DISK_CHECK_MS = 60_000;
const TICK_MS = 1000;
const CANCEL_RETRY_MS = 1000;
/** The time limit ends every call, so an older record has no live owner even if its pid came back. */
const OWNER_SLACK_MS = 60_000;

export interface CallRuntime {
  getState(): AppStateSnapshot;
  updateState(next: Partial<AppStateSnapshot>): unknown;
  on(event: "state", listener: () => void): unknown;
  off(event: "state", listener: () => void): unknown;
}

export interface CallServiceDependencies {
  audio: Pick<CallAudioClient, "watch" | "start" | "stop" | "dispose" | "onApps" | "onFault" | "onGone">;
  runtime: CallRuntime;
  root: string;
  isAvailable: () => boolean;
  isEnabled: () => boolean;
  requestMicrophone: () => Promise<boolean>;
  transcribePiece: PieceTranscriber["transcribePiece"];
  isCanceled: (error: unknown) => boolean;
  saveTranscript: (record: CallRecord, app: CallApp, segments: TranscriptSegment[]) => Promise<void>;
  freeBytes?: (path: string) => Promise<number>;
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  cancelRetryMs?: number;
}

interface ActiveCall {
  record: CallRecord;
  app: CallApp;
  lastDiskCheck: number;
}

async function diskFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return info.bavail * info.bsize;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isModelFree(state: AppStateSnapshot): boolean {
  return state.status === "idle" || state.status === "error";
}

/** Owns the whole life of a call: suggestion, recording, then transcription in the background. */
export class CallService {
  private readonly store: CallStore;
  private readonly detector = new CallDetector();
  private readonly now: () => number;
  private readonly freeBytes: (path: string) => Promise<number>;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private state: CallState;
  private activity: AppActivity[] = [];
  private active: ActiveCall | null = null;
  /** Calls the disk would not update. The audio stays, and they wait here for a retry instead of looping. */
  private readonly unsaved = new Map<string, CallRecord>();
  private starting = false;
  private startFault = false;
  private stopping = false;
  private draining = false;
  private disposed = false;
  /** Runs from the start of a delete-all to the end. Bumped at the end, so what started before it stays stale. */
  private clearing = false;
  private generation = 0;
  private finishing: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dependencies: CallServiceDependencies) {
    this.store = new CallStore(dependencies.root);
    this.now = dependencies.now ?? Date.now;
    this.freeBytes = dependencies.freeBytes ?? diskFreeBytes;
    this.pid = dependencies.pid ?? process.pid;
    this.isProcessAlive = dependencies.isProcessAlive ?? processAlive;
    this.state = {
      available: dependencies.isAvailable(), suggestion: null, recording: null, processing: null, failures: [], notice: null
    };
    dependencies.audio.onApps = (apps) => this.onApps(apps);
    dependencies.audio.onFault = () => this.markPartial();
    dependencies.audio.onGone = () => this.onHelperGone();
  }

  private setState(next: Partial<CallState>): void {
    this.state = { ...this.state, ...next };
    this.dependencies.runtime.updateState({ call: this.state });
  }

  /** Brings the helper in line with the setting, and picks up what an earlier run left behind. */
  async initialize(): Promise<void> {
    this.setState({ available: this.dependencies.isAvailable() });
    this.sync();
    if (!this.state.available) return;
    const records = await this.store.list();
    for (const record of records) {
      if (record.status !== "recording" || this.hasLiveOwner(record)) continue;
      record.status = "pending";
      record.partial = true;
      const lengthMs = await recordedLengthMs(this.store, record.id);
      if (lengthMs > 0) record.endedAt = record.startedAt + lengthMs;
      await this.store.save(record);
    }
    this.setState({ failures: this.failuresOf(records) });
    void this.drain();
  }

  /** Another running copy may be writing this folder. This process's own pid means an earlier run that shared it. */
  private hasLiveOwner(record: CallRecord): boolean {
    const { ownerPid } = record;
    if (!ownerPid || ownerPid === this.pid) return false;
    return this.now() - record.startedAt < MAX_CALL_MS + OWNER_SLACK_MS && this.isProcessAlive(ownerPid);
  }

  sync(): void {
    if (this.disposed) return;
    const watching = this.state.available && (this.dependencies.isEnabled() || this.active !== null);
    this.dependencies.audio.watch(watching ? CALL_APPS.flatMap((app) => app.prefixes) : null);
    if (watching && !this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref();
    }
    if (!watching) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.activity = [];
      this.setState({ suggestion: null });
    }
  }

  private failuresOf(records: CallRecord[]): CallState["failures"] {
    return records.filter((record) => record.status === "failed" || this.unsaved.has(record.id)).flatMap((record) => {
      const app = callAppById(record.appId);
      return app ? [{ id: record.id, app: app.kind, startedAt: record.startedAt }] : [];
    });
  }

  private onApps(apps: HelperApp[]): void {
    const merged = new Map<string, AppActivity>();
    for (const helper of apps) {
      const app = callAppForBundle(helper.id);
      if (!app) continue;
      const current = merged.get(app.id) ?? { id: app.id, input: false, output: false };
      merged.set(app.id, { id: app.id, input: current.input || helper.input, output: current.output || helper.output });
    }
    this.activity = [...merged.values()];
    this.tick();
  }

  private tick(): void {
    const now = this.now();
    this.detector.update(this.activity, now);
    const active = this.active;
    if (active) {
      if (this.stopping) return;
      if (now - active.record.startedAt >= MAX_CALL_MS || this.detector.hasEnded(active.app.id, now)) void this.finishRecording();
      else if (now - active.lastDiskCheck >= DISK_CHECK_MS) void this.checkDisk(active, now);
      return;
    }
    const canSuggest = !this.starting && !this.stopping && this.dependencies.isEnabled();
    const id = canSuggest ? this.detector.suggestion(now) : null;
    const suggestion = id ? callAppById(id)?.kind ?? null : null;
    if (suggestion !== this.state.suggestion) this.setState({ suggestion });
  }

  private async checkDisk(active: ActiveCall, now: number): Promise<void> {
    active.lastDiskCheck = now;
    const free = await this.freeBytes(this.dependencies.root).catch(() => Number.POSITIVE_INFINITY);
    if (free >= MIN_FREE_WHILE_RECORDING || this.active !== active) return;
    this.setState({ notice: "low_disk" });
    await this.finishRecording();
  }

  /** Runs only from a click. Nothing here is reachable from detection. */
  async accept(): Promise<void> {
    const id = this.detector.suggestion(this.now());
    const app = id ? callAppById(id) : null;
    if (!app || this.active || this.starting) return;
    this.starting = true;
    this.setState({ suggestion: null, notice: null });
    const record = createCallRecord(crypto.randomUUID(), app.id, this.now(), this.pid);
    try {
      if (!(await this.dependencies.requestMicrophone())) {
        this.detector.dismiss(app.id, this.now());
        this.setState({ notice: "needs_microphone" });
        return;
      }
      await this.store.create(record);
      if (await this.freeBytes(this.dependencies.root).catch(() => 0) < MIN_FREE_TO_START) throw new Error("low disk");
      this.startFault = false;
      if (!await this.dependencies.audio.start(this.store.directory(record.id), app.prefixes)) throw new Error("start failed");
      // The helper reports a failed microphone and then starts anyway, so this may already be one-sided.
      record.partial = this.startFault;
      this.active = { record, app, lastDiskCheck: this.now() };
      this.setState({ recording: { app: app.kind, startedAt: record.startedAt } });
    } catch (error) {
      this.detector.dismiss(app.id, this.now());
      await this.store.remove(record.id);
      this.setState({ notice: error instanceof Error && error.message === "low disk" ? "low_disk" : "start_failed" });
    } finally {
      this.starting = false;
    }
  }

  dismiss(): void {
    const id = this.detector.suggestion(this.now());
    if (id) this.detector.dismiss(id, this.now());
    this.setState({ suggestion: null });
  }

  /** The user said this call is over, so it is not offered again until it really ends. */
  async stop(): Promise<void> {
    if (this.active) this.detector.dismiss(this.active.app.id, this.now());
    await this.finishRecording();
  }

  private markPartial(): void {
    if (this.active) this.active.record.partial = true;
    else this.startFault = true;
  }

  private onHelperGone(): void {
    if (!this.active || this.stopping) return;
    this.active.record.partial = true;
    void this.finishRecording();
  }

  /** Every caller waits for the stop under way, so a helper or folder is never pulled out from under it. A new call can begin during that save, so check again after it. */
  private async finishRecording(): Promise<void> {
    while (this.finishing) await this.finishing.catch(() => undefined);
    if (!this.active) return;
    this.finishing = this.endRecording().finally(() => { this.finishing = null; });
    await this.finishing;
  }

  private async endRecording(): Promise<void> {
    const active = this.active;
    if (!active || this.stopping) return;
    this.stopping = true;
    const stopped = await this.dependencies.audio.stop();
    const { record } = active;
    this.active = null;
    this.stopping = false;
    record.endedAt = this.now();
    record.status = "pending";
    if (stopped) Object.assign(record, stopped);
    else record.partial = true;
    this.setState({ recording: null });
    this.sync();
    if (this.clearing) return;
    await this.store.save(record).catch(() => this.holdUnsaved(record));
    void this.drain();
  }

  /** A failed save leaves the old record beside the audio, so a later launch also recovers it. */
  private async holdUnsaved(record: CallRecord): Promise<void> {
    console.warn("[CallService] could not save a finished call; audio kept for retry");
    const records = await this.store.list();
    if (!records.some((candidate) => candidate.id === record.id)) {
      this.setState({ notice: "partial_audio" });
      return;
    }
    this.unsaved.set(record.id, record);
    this.setState({ failures: this.failuresOf(records) });
  }

  private async waitForTurn(): Promise<void> {
    const { runtime } = this.dependencies;
    const free = () => this.disposed || (isModelFree(runtime.getState()) && !this.active);
    if (free()) return;
    if (this.state.processing) this.setState({ processing: { ...this.state.processing, waiting: true } });
    await new Promise<void>((resolve) => {
      const listener = () => {
        if (!free()) return;
        runtime.off("state", listener);
        resolve();
      };
      runtime.on("state", listener);
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const { generation } = this;
        const records = await this.store.list();
        const record = records.find((candidate) => candidate.status === "pending" && !this.unsaved.has(candidate.id));
        if (!record || this.disposed || this.clearing) break;
        await this.process(record, () => this.disposed || this.clearing || generation !== this.generation);
        if (this.disposed) break;
      }
    } finally {
      this.draining = false;
      if (!this.disposed) this.setState({ processing: null });
    }
  }

  private async process(record: CallRecord, isStale: () => boolean): Promise<void> {
    const app = callAppById(record.appId);
    if (!app) return;
    this.setState({ processing: { progressRatio: 0, waiting: !isModelFree(this.dependencies.runtime.getState()) } });
    let notice: CallNotice | null = null;
    try {
      const segments = await transcribeCall(record, this.store, {
        transcribePiece: this.dependencies.transcribePiece,
        waitForTurn: () => this.waitForTurn(),
        pauseAfterCancel: () => new Promise((resolve) => setTimeout(resolve, this.dependencies.cancelRetryMs ?? CANCEL_RETRY_MS)),
        isCanceled: this.dependencies.isCanceled
      }, (progressRatio) => this.setState({ processing: { progressRatio, waiting: false } }), isStale);
      if (!segments || isStale()) return;
      if (segments.length > 0) {
        const saving = this.dependencies.saveTranscript(record, app, segments);
        this.saving = saving.catch(() => undefined);
        await saving;
      }
      if (segments.length === 0) notice = "no_speech";
      else if (record.system.segments.length === 0 && !record.systemHeard) notice = "others_silent";
      else if (record.partial) notice = "partial_audio";
      await this.store.remove(record.id);
      if (notice) this.setState({ notice });
    } catch {
      console.warn("[CallService] transcription failed; audio kept for retry");
      if (isStale()) return;
      record.status = "failed";
      // After delete-all the folder is gone, and with it this failure.
      await this.store.save(record).catch(() => this.unsaved.set(record.id, record));
      this.setState({ failures: this.failuresOf(await this.store.list()) });
    }
  }

  async retry(id: string): Promise<void> {
    const listed = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!listed) return;
    const record = this.unsaved.get(id) ?? listed;
    record.status = "pending";
    await this.store.save(record);
    this.unsaved.delete(id);
    this.setState({ failures: this.state.failures.filter((failure) => failure.id !== id) });
    void this.drain();
  }

  async discard(id: string): Promise<void> {
    await this.store.remove(id);
    this.unsaved.delete(id);
    this.setState({ failures: this.state.failures.filter((failure) => failure.id !== id) });
  }

  dismissNotice(): void {
    this.setState({ notice: null });
  }

  /** Deleting everything has to reach audio that has not become a transcript yet. */
  async clearAll(): Promise<void> {
    this.clearing = true;
    try {
      await this.finishRecording().catch(() => undefined);
      await this.saving;
      await this.store.clear();
    } finally {
      this.clearing = false;
      this.generation += 1;
      // Drain stopped for the delete. If the delete failed, what is left still needs it.
      void this.drain();
    }
    this.unsaved.clear();
    this.setState({ failures: [], notice: null, processing: null });
  }

  /** Sleep ends the capture. The audio stays and transcribes after wake. */
  async suspend(): Promise<void> {
    await this.finishRecording();
  }

  async dispose(): Promise<void> {
    await this.finishRecording();
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.dependencies.audio.dispose();
  }
}
