import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { IvritMenuBarApi } from "../../src/shared/preload-api";
import { he } from "../../src/shared/locale";
type AppGlobal = typeof globalThis & { ivritMenuBar: IvritMenuBarApi };

// Samples the built app (out/) in mock mode with an isolated profile. Mock mode has no hold key,
// call detection, updates or ASR worker, so these numbers are the Electron floor for each UI state.
// Playwright keeps a debugging pipe open, which the "unattached" run elsewhere measures separately.
test.describe.configure({ mode: "serial" });

const seconds = process.env.MELULI_PERF_SECONDS ?? "60";
const out = resolve(process.env.MELULI_PERF_OUT ?? "tmp/meluli-2/results");
const scratch = resolve(process.env.MELULI_PERF_PROFILES ?? "tmp/meluli-2/profiles");
let app: ElectronApplication, page: Page, profile: string;

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
function measure(label: string) {
  const pid = app.process().pid!;
  const text = execFileSync("node", ["scripts/meluli2/measure-processes.mjs", "--root", String(pid), "--label", label, "--seconds", seconds, "--out", out], { encoding: "utf8" });
  console.log(text.trim());
}
const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({
  kind: w.webContents.getURL().includes("window=overlay") ? "overlay" : w.webContents.getURL().includes("window=call") ? "call" : w.webContents.getURL().includes("window=main") ? "main" : "other",
  visible: w.isVisible(), destroyed: w.isDestroyed()
})));
async function hideMain() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("window=main"))?.close());
  await expect.poll(async () => (await windows()).filter((w) => w.kind === "main" && w.visible).length).toBe(0);
}
async function showMain() {
  await app.evaluate(({ app: electronApp }) => { electronApp.emit("activate"); });
  await expect.poll(async () => (await windows()).some((w) => w.kind === "main" && w.visible)).toBe(true);
  await expect.poll(() => app.windows().some((w) => w.url().includes("window=main"))).toBe(true);
  page = app.windows().find((w) => w.url().includes("window=main"))!;
  await page.waitForFunction(() => Boolean((globalThis as AppGlobal).ivritMenuBar));
}

test.beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  mkdirSync(out, { recursive: true });
  profile = mkdtempSync(join(scratch, "idle-"));
  app = await electron.launch({ args: ["."], env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile } });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean((globalThis as AppGlobal).ivritMenuBar));
  await page.evaluate(async () => {
    const api = (globalThis as AppGlobal).ivritMenuBar;
    await api.model.download();
    await api.settings.set("onboarding", { phase: "activated", surface: "workspace", activatedAt: Date.now(), completedOptionalActions: ["recording_shortcut", "overlay_accessibility"], dismissedOptionalActions: [] });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeVisible();
});
test.afterAll(async () => { if (app) await app.close(); if (profile) rmSync(profile, { recursive: true, force: true }); });

test("main window visible and idle", async () => {
  await settle(10_000);
  measure("mock-main-visible");
});

test("main window closed", async () => {
  await hideMain();
  await settle(10_000);
  console.log(JSON.stringify(await windows()));
  measure("mock-main-closed");
});

test("after five open and close cycles", async () => {
  for (let cycle = 0; cycle < 5; cycle++) { await showMain(); await settle(1_000); await hideMain(); }
  await settle(10_000);
  console.log(JSON.stringify(await windows()));
  measure("mock-after-5-cycles");
});

test("after a mock dictation through the HUD", async () => {
  await showMain();
  const opened = app.waitForEvent("window");
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  const overlay = await opened;
  await expect(overlay.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  await overlay.getByRole("button", { name: he.startRecording, exact: true }).click();
  await settle(1_500);
  await overlay.getByRole("button", { name: he.stopRecording, exact: true }).click();
  await expect(overlay.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled({ timeout: 15_000 });
  await hideMain();
  await settle(15_000);
  console.log(JSON.stringify(await windows()));
  measure("mock-after-hud-dictation");
});
