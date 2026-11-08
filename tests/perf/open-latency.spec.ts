import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { IvritMenuBarApi } from "../../src/shared/preload-api";
import { he } from "../../src/shared/locale";
type AppGlobal = typeof globalThis & { ivritMenuBar: IvritMenuBarApi };

// How long the main window and the HUD take to become usable, warm (window kept) and cold
// (window released or never created). Timed from the main process request to the first enabled
// record button, as seen through Playwright, so each value includes one Playwright round trip.
test.describe.configure({ mode: "serial" });

const out = resolve(process.env.MELULI_PERF_OUT ?? "tmp/meluli-2/results");
const scratch = resolve(process.env.MELULI_PERF_PROFILES ?? "tmp/meluli-2/profiles");
const repetitions = Number(process.env.MELULI_PERF_REPETITIONS ?? 5);
const releaseMs = 1_500;
let app: ElectronApplication, profile: string;
const results: Record<string, number[]> = {};
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

const mainPage = () => app.windows().find((w) => w.url().includes("window=main"));
async function hideMain() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("window=main"))?.close());
}
const mainAlive = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("window=main")));

async function timeMainOpen(): Promise<number> {
  const started = performance.now();
  await app.evaluate(({ app: electronApp }) => { electronApp.emit("activate"); });
  await expect.poll(() => Boolean(mainPage()), { intervals: [5] }).toBe(true);
  await expect(mainPage()!.getByRole("button", { name: he.startRecording, exact: true }).first()).toBeVisible();
  return performance.now() - started;
}

async function timeOverlayOpen(page: Page): Promise<number> {
  const started = performance.now();
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  await expect.poll(() => Boolean(app.windows().find((w) => w.url().includes("window=overlay"))), { intervals: [5] }).toBe(true);
  const overlay = app.windows().find((w) => w.url().includes("window=overlay"))!;
  await expect(overlay.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  return performance.now() - started;
}

test.beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  profile = mkdtempSync(join(scratch, "latency-"));
  app = await electron.launch({ args: ["."], env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile, MELULI_MAIN_RELEASE_MS: String(releaseMs) } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean((globalThis as AppGlobal).ivritMenuBar));
  await page.evaluate(async () => {
    const api = (globalThis as AppGlobal).ivritMenuBar;
    await api.model.download();
    await api.settings.set("onboarding", { phase: "activated", surface: "workspace", activatedAt: Date.now(), completedOptionalActions: ["recording_shortcut", "overlay_accessibility"], dismissedOptionalActions: [] });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeVisible();
});
test.afterAll(async () => {
  mkdirSync(out, { recursive: true });
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
  const summary = Object.fromEntries(Object.entries(results).map(([name, values]) => [name, { medianMs: Math.round(median(values)), maxMs: Math.round(Math.max(...values)), runs: values.map(Math.round) }]));
  writeFileSync(join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-open-latency.json`), JSON.stringify({ releaseMs, repetitions, summary }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  if (app) await app.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test("main window reopen, warm and released", async () => {
  results.mainWarm = []; results.mainReleased = [];
  for (let run = 0; run < repetitions; run++) {
    await hideMain();
    await settle(200);
    results.mainWarm.push(await timeMainOpen());
    await hideMain();
    await expect.poll(mainAlive, { timeout: releaseMs + 5_000 }).toBe(false);
    await settle(500);
    results.mainReleased.push(await timeMainOpen());
    await settle(500);
  }
});

test("HUD open, first and again", async () => {
  const page = mainPage()!;
  results.hudCold = [await timeOverlayOpen(page)];
  results.hudWarm = [];
  for (let run = 0; run < repetitions; run++) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("window=overlay"))?.hide());
    await settle(300);
    results.hudWarm.push(await timeOverlayOpen(page));
  }
});
