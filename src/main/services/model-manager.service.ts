import { mkdirSync, existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { DEFAULT_MODEL_FILENAME, DEFAULT_MODEL_ID, DEFAULT_MODEL_URL } from "@shared/constants";
import { he } from "@shared/locale";
import { modelStateSchema } from "@shared/schemas";
import type { ModelDownloadProgress, ModelState } from "@shared/types";
import type { BinaryPaths } from "../config/paths";
import { MODEL_MANIFEST } from "../config/model-manifest";
import { SettingsService } from "./settings.service";
import { ModelIntegrity } from "./model-integrity";
import { downloadVerifiedModel } from "./verified-download";

export class ModelManager extends EventEmitter {
  private downloadPromise: Promise<ModelState> | null = null;
  private abort = new AbortController();
  private disposed = false;
  private lastProgressAt = 0;
  private integrity = new ModelIntegrity(MODEL_MANIFEST);
  private manifestBytes = MODEL_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0);

  constructor(private readonly modelsDir: string, private readonly settingsService: SettingsService, _binaryPaths: BinaryPaths) {
    super();
    mkdirSync(modelsDir, { recursive: true, mode: 0o700 });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort.abort(new Error("Model operation canceled."));
    await this.downloadPromise?.catch(() => undefined);
    this.removeAllListeners();
  }

  private get currentModelPath(): string { return join(this.modelsDir, DEFAULT_MODEL_FILENAME); }
  private get useMockMode(): boolean { return process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1"; }
  private emitProgress(bytesDownloaded: number, totalBytes: number): void {
    const now = Date.now();
    if (bytesDownloaded !== totalBytes && now - this.lastProgressAt < 100) return;
    this.lastProgressAt = now;
    const payload: ModelDownloadProgress = { bytesDownloaded, totalBytes, percent: Math.min(100, Math.round(bytesDownloaded / totalBytes * 100)) };
    this.emit("progress", payload);
  }

  async getState(settings = this.settingsService.getSettings()): Promise<ModelState> {
    const ready = this.useMockMode
      ? existsSync(join(this.currentModelPath, ".meluli-mock-model"))
      : await this.integrity.verify(this.currentModelPath, this.abort.signal);
    const previous = settings.modelState;
    const state = modelStateSchema.parse({
      ...previous, id: DEFAULT_MODEL_ID, url: DEFAULT_MODEL_URL, fileName: DEFAULT_MODEL_FILENAME,
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

  downloadModel(): Promise<ModelState> {
    if (this.disposed) return Promise.reject(new Error(he.modelDownloadFailed));
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.downloadModelInternal().finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  private async downloadModelInternal(): Promise<ModelState> {
    const total = this.manifestBytes;
    const base = { ...this.settingsService.getSettings().modelState, id: DEFAULT_MODEL_ID, url: DEFAULT_MODEL_URL, fileName: DEFAULT_MODEL_FILENAME };
    this.settingsService.setSetting("modelState", { ...base, filePath: null, downloadState: "downloading", bytesDownloaded: 0, totalBytes: total, lastError: null });
    try {
      if (this.useMockMode) {
        await mkdir(this.currentModelPath, { recursive: true, mode: 0o700 });
        await writeFile(join(this.currentModelPath, ".meluli-mock-model"), "Simulated model for isolated tests only.\n", { mode: 0o600 });
        this.emitProgress(total, total);
      } else {
        await downloadVerifiedModel(MODEL_MANIFEST, this.currentModelPath, this.abort.signal, (received, size) => this.emitProgress(received, size));
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
      id: DEFAULT_MODEL_ID, url: DEFAULT_MODEL_URL, fileName: DEFAULT_MODEL_FILENAME,
      filePath: null, downloadState: "missing", bytesDownloaded: 0, totalBytes: null, lastError: null
    }).modelState;
  }
}
