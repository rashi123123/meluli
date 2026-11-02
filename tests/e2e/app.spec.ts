import { installTestMicrophone } from "./helpers/microphone";
import { he } from "../../src/shared/locale";
import type { IvritMenuBarApi } from "../../src/shared/preload-api";
type AppGlobal = typeof globalThis & { ivritMenuBar: IvritMenuBarApi };
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

// These scenarios share one activation/history flow; avoid restarting later steps
// against a fresh unactivated profile after an earlier failure.
test.describe.configure({ mode: "serial" });

let electronApp: ElectronApplication;
let page: Page;
let userDataPath: string;

test.beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), "meluli-e2e-"));
  electronApp = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      IVRIT_E2E_MOCK: "1",
      MELULI_USER_DATA: userDataPath
    }
  });

  page = await electronApp.firstWindow();
  await page.waitForURL(/index\.html/);
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true });
});

test("activation onboarding completes and YouTube transcription appears in history", async ({}, testInfo) => {
  await expect(page.getByText(he.onboardingWelcomeTitle)).toBeVisible();
  await installTestMicrophone(page);
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  await expect(page.getByText("המיקרופון עובד", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.continue, exact: true }).click();

  await expect(page.getByRole("button", { name: he.startRecording, exact: true }).first()).toBeEnabled();
  await page.getByRole("button", { name: he.startRecording, exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: he.stopRecording, exact: true }).first().click();

  await expect(page.locator(".transcript-content").getByText("תמלול דמה מקומי")).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: testInfo.outputPath("main-transcript.png") });

  // Stubs the main-process clipboard so the real path runs without touching the Mac's clipboard.
  await electronApp.evaluate(({ clipboard }) => {
    const box = globalThis as typeof globalThis & { __copied?: string };
    clipboard.writeText = async text => { box.__copied = text; };
  });
  await page.locator(".transcript-channel").getByRole("button", { name: he.copy, exact: true }).click();
  await expect(page.locator(".transcript-channel").getByRole("button", { name: he.copied })).toBeVisible();
  await expect.poll(() => electronApp.evaluate(() => (globalThis as typeof globalThis & { __copied?: string }).__copied)).toContain("תמלול דמה מקומי");
  await page.getByRole("textbox", { name: he.youtubeUrlPlaceholder }).fill("https://www.youtube.com/watch?v=demo123");
  await page.getByRole("button", { name: he.youtubeSubmit, exact: true }).click();
  await expect(page.locator(".transcript-content").getByText("תמלול דמה עבור כותרת הסרטון.")).toBeVisible();

  await page.getByRole("button", { name: he.startRecording, exact: true }).first().click();
  await page.getByRole("button", { name: "הגדרות", exact: true }).click();
  await expect(page.getByRole("heading", { name: he.settings, exact: true })).toBeVisible();
  expect((await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.app.state())).status).toBe("recording");
  await page.screenshot({ path: testInfo.outputPath("main-settings.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "ביטול ההקלטה", exact: true }).click();
  await page.getByRole("button", { name: "היסטוריה" }).click();
  await page.getByPlaceholder("חיפוש בתמלולים").fill("הסרטון");
  await expect(page.locator(".history-reader").getByText("כותרת הסרטון").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("main-history.png") });
  await page.keyboard.press("Escape");
});

// UI and worker responses are explicitly simulated. Real ASR replay is a separate suite.
test("floating recorder opens idle, records once, survives blur and remembers its position", async ({}, testInfo) => {
  const opened = electronApp.waitForEvent("window");
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  const overlay = await opened;
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))?.isVisible())).toBe(true);
  await expect(overlay.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  expect((await overlay.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.app.state())).status).toBe("idle");
  await overlay.screenshot({ path: testInfo.outputPath("floating-idle.png") });
  const compact = await electronApp.evaluate(({ BrowserWindow }) => {
    const { width, height } = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))!.getBounds();
    return { width, height };
  });
  expect(compact).toEqual({ width: 320, height: 60 });

  await overlay.getByRole("button", { name: he.startRecording, exact: true }).click();
  await expect(overlay.getByRole("button", { name: he.stopRecording, exact: true })).toBeEnabled();
  await expect.poll(() => overlay.locator(".audio-meter > span").first().evaluate(bar => bar.getBoundingClientRect().height)).toBeGreaterThan(0);
  expect(await overlay.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.hide())).toBe(false);
  await overlay.getByRole("button", { name: he.pauseRecording, exact: true }).click();
  await expect.poll(() => overlay.evaluate(async () => (await (globalThis as AppGlobal).ivritMenuBar.app.state()).status)).toBe("paused");
  await overlay.getByRole("button", { name: he.resumeRecording, exact: true }).click();
  await page.bringToFront();
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))?.isVisible())).toBe(true);
  await overlay.getByRole("button", { name: he.stopRecording, exact: true }).click();
  // A landed paste says nothing: the window just leaves.
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))?.isVisible())).toBe(false);
  const bounds = await electronApp.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))!;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    window.setPosition(area.x + 150, area.y + 180);
    return window.getBounds();
  });
  await overlay.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.hide());
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  const reopened = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))!.getBounds());
  expect(reopened.x).toBe(bounds.x);
  expect(reopened.y).toBe(bounds.y);
  expect((await overlay.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.app.state())).overlaySession).toBeNull();
  await overlay.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.hide());
});

test("holding the key records without a click and the release delivers the speech", async () => {
  const before = await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.history.list(100));
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  const overlay = electronApp.windows().find(w => w.url().includes("window=overlay"))!;
  await expect(overlay.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  const hold = (phase: "press" | "release") => electronApp.evaluate(({ BrowserWindow }, phase) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))!.webContents.send("recording:hold-requested", phase);
  }, phase);
  await hold("press");
  await expect(overlay.getByRole("button", { name: he.stopRecording, exact: true })).toBeEnabled();
  await hold("release");
  await expect.poll(async () => (await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.history.list(100))).items.length).toBe(before.items.length + 1);
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))?.isVisible())).toBe(false);
});

test("floating Escape and cancel button discard recording without history or paste", async () => {
  const before = await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.history.list(100));
  for (const action of ["escape", "button"]) {
    await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
    const overlay = electronApp.windows().find(w => w.url().includes("window=overlay"))!;
    await overlay.getByRole("button", { name: he.startRecording, exact: true }).click();
    await expect(overlay.getByRole("button", { name: he.stopRecording, exact: true })).toBeEnabled();
    if (action === "escape") await overlay.keyboard.press("Escape");
    else await overlay.getByRole("button", { name: "ביטול ההקלטה", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await (globalThis as AppGlobal).ivritMenuBar.app.state()).status)).toBe("idle");
    expect((await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.app.state())).overlaySession).toBeNull();
    expect((await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.history.list(100))).items.length).toBe(before.items.length);
  }
});

// Synthetic recovery state checks layout/accessibility only, not native paste recovery.
test("floating recovery controls and long Hebrew error remain within the native window", async ({}, testInfo) => {
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  const overlay = electronApp.windows().find(window => window.url().includes("window=overlay"))!;
  const state = await overlay.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.app.state());
  await electronApp.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))!.webContents.send("app:state", {
      ...state, status: "error", overlaySession: { id: "layout-recovery", phase: "paste_failed", transcriptId: "fixture",
        transcriptText: "תמלול שנשמר לבדיקה", targetAppName: "Test Editor", lastErrorCode: "permission" }
    });
  }, state);
  await expect(overlay.getByRole("button", { name: he.copy, exact: true })).toBeVisible();
  await overlay.screenshot({ path: testInfo.outputPath("floating-recovery.png") });
  const controls = await overlay.locator("button:visible").all();
  const viewport = await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const nativeSize = await electronApp.evaluate(({ BrowserWindow }) => {
    const { width, height } = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay"))!.getBounds();
    return { width, height };
  });
  expect(nativeSize).toEqual({ width: 320, height: 148 });
  for (const control of controls) {
    const bounds = (await control.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(30);
    expect(bounds.height).toBeGreaterThanOrEqual(30);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  }
});
