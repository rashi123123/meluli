import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { IvritMenuBarApi } from "../../src/shared/preload-api";
import { he } from "../../src/shared/locale";
type AppGlobal = typeof globalThis & { ivritMenuBar: IvritMenuBarApi };

// A hidden main window gives its renderer back after a delay, unless it holds a recording or an edit.
test.describe.configure({ mode: "serial" });
const releaseMs = 1_000;
let app: ElectronApplication, page: Page, profile: string;

const mainAlive = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("window=main")));
const hideMain = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("window=main"))?.close());
async function reopen() {
  await app.evaluate(({ app: electronApp }) => { electronApp.emit("activate"); });
  await expect.poll(() => app.windows().some((w) => w.url().includes("window=main"))).toBe(true);
  page = app.windows().find((w) => w.url().includes("window=main"))!;
  await page.waitForFunction(() => Boolean((globalThis as AppGlobal).ivritMenuBar));
}

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "meluli-release-"));
  app = await electron.launch({ args: ["."], env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile, MELULI_MAIN_RELEASE_MS: String(releaseMs) } });
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

test("a hidden main window is released and reopens on the view it showed", async () => {
  await page.getByRole("button", { name: he.history, exact: true }).click();
  await expect(page.getByRole("button", { name: he.history, exact: true })).toHaveAttribute("aria-current", "page");
  await hideMain();
  await expect.poll(mainAlive, { timeout: releaseMs + 5_000 }).toBe(false);
  await reopen();
  await expect(page.getByRole("button", { name: he.history, exact: true })).toHaveAttribute("aria-current", "page");
});

test("a navigation request recreates a released window on the requested view", async () => {
  const opened = app.waitForEvent("window");
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  const overlay = await opened;
  await overlay.waitForFunction(() => Boolean((globalThis as AppGlobal).ivritMenuBar));
  await hideMain();
  await expect.poll(mainAlive, { timeout: releaseMs + 5_000 }).toBe(false);
  // The HUD's links and the tray's items go through the same host call.
  await overlay.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.app.showMain("dictionary"));
  await expect.poll(() => app.windows().some((w) => w.url().includes("window=main"))).toBe(true);
  page = app.windows().find((w) => w.url().includes("window=main"))!;
  await expect(page.getByRole("button", { name: he.dictionaryTitle, exact: true })).toHaveAttribute("aria-current", "page");
});

test("a recording started in the main window keeps it while hidden", async () => {
  await page.getByRole("button", { name: "בית", exact: true }).click();
  await page.getByRole("button", { name: he.startRecording, exact: true }).first().click();
  await expect(page.getByRole("button", { name: he.stopRecording, exact: true }).first()).toBeVisible();
  await hideMain();
  await page.waitForTimeout(releaseMs * 3);
  expect(await mainAlive()).toBe(true);
  await reopen();
  await page.getByRole("button", { name: he.stopRecording, exact: true }).first().click();
  await expect(page.locator(".transcript-content").getByText("תמלול דמה מקומי")).toBeVisible({ timeout: 15_000 });
  await hideMain();
  await expect.poll(mainAlive, { timeout: releaseMs + 5_000 }).toBe(false);
});

test("a minimized main window is never released", async () => {
  await reopen();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("window=main"))?.minimize());
  await page.waitForTimeout(releaseMs * 3);
  expect(await mainAlive()).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("window=main"))?.restore());
});
