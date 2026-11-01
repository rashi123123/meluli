/* @vitest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";
import { resolveBinaryPaths } from "@main/config/paths";
import { SettingsService } from "@main/services/settings.service";
import { DEFAULT_MODEL_FILENAME } from "@shared/constants";
import { ModelManager } from "@main/services/model-manager.service";

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
      settingsService,
      resolveBinaryPaths({ isPackaged: false })
    );

    const state = await manager.downloadModel();

    expect(state.downloadState).toBe("ready");
    expect(state.filePath).toContain(DEFAULT_MODEL_FILENAME);
    expect((await manager.getState()).downloadState).toBe("ready");
    await manager.dispose();
    database.db?.close();
  });
});
