/* @vitest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";
import { SettingsService } from "@main/services/settings.service";
import { DEFAULT_MODEL_FILENAME } from "@shared/constants";
import { ModelManager } from "@main/services/model-manager.service";
import { WHISPER_ENGINE, ZIPFORMER_ENGINE } from "@main/config/asr-engine";

const tempDirs: string[] = [];

beforeEach(() => {
  process.env.IVRIT_USE_MOCK_SERVICES = "1";
});

afterEach(() => {
  delete process.env.IVRIT_USE_MOCK_SERVICES;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ModelManager", () => {
  it("supports mock downloads for automated tests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ivrit-model-test-"));
    tempDirs.push(dir);
    const database = createAppDatabase(dir);
    const settingsService = new SettingsService(database.settingsRepository);
    const manager = new ModelManager(
      database.paths.modelsDir,
      settingsService
    );

    const state = await manager.downloadModel();

    expect(state.downloadState).toBe("ready");
    expect(state.filePath).toContain(DEFAULT_MODEL_FILENAME);
    expect((await manager.getState()).downloadState).toBe("ready");
    await manager.dispose();
    database.db?.close();
  });

  it("keeps each engine's model apart, so a switch never borrows the other's state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ivrit-model-test-"));
    tempDirs.push(dir);
    const database = createAppDatabase(dir);
    const settingsService = new SettingsService(database.settingsRepository);
    const whisper = new ModelManager(database.paths.modelsDir, settingsService, () => {}, WHISPER_ENGINE);
    const zipformer = new ModelManager(database.paths.modelsDir, settingsService, () => {}, ZIPFORMER_ENGINE);
    await whisper.downloadModel();

    const fresh = await zipformer.getState();
    expect(fresh).toMatchObject({ id: ZIPFORMER_ENGINE.model.id, downloadState: "missing", filePath: null, totalBytes: 72_316_960 });
    await zipformer.downloadModel();
    expect(await zipformer.requireWorkerModelPath()).toBe(join(database.paths.modelsDir, ZIPFORMER_ENGINE.model.fileName, "sherpa-onnx"));

    // Back to Whisper: its files were never touched.
    expect(await whisper.getState()).toMatchObject({ id: WHISPER_ENGINE.model.id, downloadState: "ready" });
    zipformer.removeModel();
    expect((await whisper.getState()).downloadState).toBe("ready");
    expect((await zipformer.getState()).downloadState).toBe("missing");
    await whisper.dispose(); await zipformer.dispose();
    database.db?.close();
  });
});
