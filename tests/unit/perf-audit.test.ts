/* @vitest-environment node */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ app: { isPackaged: false }, startRecording: vi.fn(async () => {}) }));
vi.mock("electron", () => ({ app: h.app, contentTracing: { startRecording: h.startRecording } }));

describe("performance audit switch", () => {
  let profile: string;
  const start = async () => (await import("@main/perf-audit")).startPerformanceAudit(profile);

  beforeEach(() => {
    vi.resetModules();
    h.startRecording.mockClear();
    h.app.isPackaged = false;
    vi.stubEnv("IVRIT_PERF_AUDIT", "1");
    profile = mkdtempSync(join(tmpdir(), "meluli-perf-audit-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(profile, { recursive: true, force: true });
  });

  it("records in development", async () => {
    await start();
    expect(h.startRecording).toHaveBeenCalledOnce();
  });

  it("is ignored by a packaged app", async () => {
    h.app.isPackaged = true;
    await start();
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it("records in a packaged build made for debugging", async () => {
    h.app.isPackaged = true;
    vi.stubGlobal("__MELULI_ALLOW_DEBUG_SWITCHES__", true);
    await start();
    expect(h.startRecording).toHaveBeenCalledOnce();
  });
});
