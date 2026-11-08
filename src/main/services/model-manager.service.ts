import { mkdirSync, existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { he } from "@shared/locale";
import { modelStateSchema } from "@shared/schemas";
import type { ModelDownloadProgress, ModelState } from "@shared/types";
import { PRODUCT_ASR_ENGINE, type AsrEngine } from "../config/asr-engine";
import { SettingsService } from "./settings.service";
import { ModelIntegrity } from "./model-integrity";
import { downloadVerifiedModel } from "./verified-download";
import { isMockMode } from "../config/mock-mode";

export class ModelManager {
  private downloadPromise: Promise<ModelState> | null = null;
  private abort = new AbortController();
  private disposed = false;
  private lastProgressAt = 0;
  private readonly integrity: ModelIntegrity;
  private readonly manifestBytes: number;

  /** `onProgress` hears download progress, at most every 100 ms and always the last chunk. */
  constructor(
    private readonly modelsDir: string,
    private readonly settingsService: SettingsService,
    private readonly onProgress: (progress: ModelDownloadProgress) => void = () => {},
    private readonly engine: AsrEngine = PRODUCT_ASR_ENGINE
  ) {
    mkdirSync(modelsDir, { recursive: true, mode: 0o700 });
    this.manifestBytes = engine.model.manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    // Each engine keeps its own record, so switching engines never trusts the other's files.
    const record = engine.id === "whisper" ? ".meluli-verified.json" : `.meluli-verified-${engine.id}.json`;
    this.integrity = new ModelIntegrity(engine.model.manifest, join(modelsDir, record));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort.abort(new Error("Model operation canceled."));
    await this.downloadPromise?.catch(() => undefined);
  }

  private get currentModelPath(): string { return join(this.modelsDir, this.engine.model.fileName); }
  private get identity() { return { id: this.engine.model.id, url: this.engine.model.url, fileName: this.engine.model.fileName }; }
  private emitProgress(bytesDownloaded: number, totalBytes: number): void {
    const now = Date.now();
    if (bytesDownloaded !== totalBytes && now - this.lastProgressAt < 100) return;
    this.lastProgressAt = now;
    const payload: ModelDownloadProgress = { bytesDownloaded, totalBytes, percent: Math.min(100, Math.round(bytesDownloaded / totalBytes * 100)) };
    this.onProgress(payload);
  }

  get isDownloading(): boolean { return this.downloadPromise !== null; }

  async getState(settings = this.settingsService.getSettings()): Promise<ModelState> {
    const ready = isMockMode()
      ? existsSync(join(this.currentModelPath, ".meluli-mock-model"))
      : await this.integrity.verify(this.currentModelPath, this.abort.signal);
    // The stored state is the last engine's; a switch starts this engine's from its own files.
    const stored = settings.modelState;
    const previous = stored.id === this.engine.model.id ? stored
      : { ...stored, downloadState: "missing" as const, bytesDownloaded: 0, totalBytes: null, lastError: null };
    const state = modelStateSchema.parse({
      ...previous, ...this.identity,
      filePath: ready ? this.currentModelPath : null,
      downloadState: this.downloadPromise ? "downloading" : ready ? "ready" : previous.downloadState === "error" ? "error" : "missing",
      totalBytes: previous.totalBytes ?? this.manifestBytes,
      lastError: ready ? null : previous.lastError
    });
    if (!this.disposed && JSON.stringify(state) !== JSON.stringify(previous)) this.settingsService.setSetting("modelState", state);
    return state;
  }

  async requireModelPath(): Promise<string> {
    const state = await this.getState();
    if (state.downloadState !== "ready" || !state.filePath) throw new Error(he.localModelMissingError);
    return state.filePath;
  }

  /** The path the engine's worker loads. */
  async requireWorkerModelPath(): Promise<string> {
    return this.engine.model.workerPath(await this.requireModelPath());
  }

  downloadModel(): Promise<ModelState> {
    if (this.disposed) return Promise.reject(new Error(he.modelDownloadFailed));
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.downloadModelInternal().finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  private async downloadModelInternal(): Promise<ModelState> {
    const total = this.manifestBytes;
    const base = { ...this.settingsService.getSettings().modelState, ...this.identity };
    this.settingsService.setSetting("modelState", { ...base, filePath: null, downloadState: "downloading", bytesDownloaded: 0, totalBytes: total, lastError: null });
    try {
      if (isMockMode()) {
        await mkdir(this.currentModelPath, { recursive: true, mode: 0o700 });
        await writeFile(join(this.currentModelPath, ".meluli-mock-model"), "Simulated model for isolated tests only.\n", { mode: 0o600 });
        this.emitProgress(total, total);
      } else {
        await downloadVerifiedModel(this.engine.model.manifest, this.currentModelPath, this.abort.signal, (received, size) => this.emitProgress(received, size));
        this.integrity.invalidate(this.currentModelPath);
        if (!(await this.integrity.verify(this.currentModelPath, this.abort.signal))) throw new Error("Model integrity check failed.");
      }
      return this.settingsService.setSetting("modelState", { ...base, filePath: this.currentModelPath, downloadState: "ready", bytesDownloaded: total, totalBytes: total, lastError: null }).modelState;
    } catch (error) {
      const message = error instanceof Error && "code" in error && error.code === "ENOSPC"
        ? "אין מספיק מקום פנוי להורדת המנוע. אפשר לפנות מקום ולנסות שוב."
        : he.modelDownloadFailed;
      if (!this.disposed) this.settingsService.setSetting("modelState", { ...base, filePath: null, downloadState: "error", bytesDownloaded: 0, totalBytes: total, lastError: message });
      throw new Error(message);
    }
  }

  removeModel(): ModelState {
    if (this.downloadPromise) throw new Error("הורדת המודל עדיין פעילה.");
    rmSync(this.currentModelPath, { recursive: true, force: true });
    this.integrity.invalidate(this.currentModelPath);
    return this.settingsService.setSetting("modelState", { ...this.settingsService.getSettings().modelState,
      ...this.identity,
      filePath: null, downloadState: "missing", bytesDownloaded: 0, totalBytes: null, lastError: null
    }).modelState;
  }
}
