import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { IvritMenuBarApi } from "../../src/shared/preload-api";
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE } from "../../src/shared/constants";
import { he } from "../../src/shared/locale";
import type { AppStateSnapshot } from "../../src/shared/types";
type AppGlobal = typeof globalThis & { ivritMenuBar: IvritMenuBarApi };
let app: ElectronApplication, page: Page, profile: string;

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "meluli-interface-"));
  app = await electron.launch({ args: ["."], env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile }, colorScheme: "dark" });
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

async function displayState(snapshot: AppStateSnapshot, overlay = false) {
  await app.evaluate(({ BrowserWindow }, input) => {
    const target = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("window=overlay") === input.overlay)!;
    target.webContents.send("app:state", input.snapshot);
  }, { snapshot, overlay });
}

// Synthetic runtime states exercise presentation only; the recording flow is covered by app.spec.
test("runtime states keep the device's shape, RTL geometry and reachable controls", async ({}, info) => {
  let deviceHeight = 0;
  for (const status of ["idle", "recording", "paused", "processing", "youtube_downloading", "error"] as const) {
    await displayState({ status, timerStartedAt: status === "paused" ? 12_000 : Date.now(), activeSourceType: status === "youtube_downloading" ? "youtube" : "microphone" });
    await expect(page.locator(`.state-${status}`)).toBeVisible();
    const geometry = await page.evaluate(() => {
      const sidebar = document.querySelector(".desktop-sidebar")!.getBoundingClientRect();
      const main = document.querySelector(".desktop-main")!.getBoundingClientRect();
      const device = document.querySelector(".device")!.getBoundingClientRect();
      const cells = Array.from(document.querySelectorAll(".device .quick-action"), cell => {
        const rect = cell.getBoundingClientRect(), style = getComputedStyle(cell);
        return { right: rect.right, x: rect.x, width: rect.width, height: rect.height, left: style.paddingLeft, rightInset: style.paddingRight, top: style.paddingTop, bottom: style.paddingBottom, visible: rect.width > 0 && style.visibility !== "hidden" };
      });
      return { rtl: sidebar.x >= main.right - 1, overflow: document.documentElement.scrollWidth > innerWidth, device: { x: device.x, right: device.right, height: device.height }, cells };
    });
    expect(geometry.rtl).toBe(true); expect(geometry.overflow).toBe(false);
    deviceHeight ||= geometry.device.height;
    expect(geometry.device.height, `${status}: the device must not jump between states`).toBeCloseTo(deviceHeight, 0);
    for (const cell of geometry.cells.filter(item => item.visible)) {
      expect(cell.width).toBeCloseTo(geometry.cells[0].width, 0);
      expect(cell.height).toBeCloseTo(geometry.cells[0].height, 0);
      expect(cell.left).toBe(cell.rightInset); expect(cell.top).toBe(cell.bottom);
      expect(cell.x).toBeGreaterThanOrEqual(geometry.device.x - 1);
      expect(cell.right).toBeLessThanOrEqual(geometry.device.right + 1);
    }
    if (["recording", "paused"].includes(status)) {
      const fill = () => page.locator(".record-action").evaluate(el => getComputedStyle(el).backgroundImage);
      await page.mouse.move(0, 0); // the pointer may still rest on this button from the previous state
      const resting = await fill();
      await page.locator(".record-action").hover();
      await expect.poll(fill).not.toBe(resting);
    }
    if (["recording", "paused", "processing", "youtube_downloading"].includes(status)) await expect(page.locator(".control-dock")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`main-${status}.png`) });
  }
  await displayState({ status: "idle", timerStartedAt: null });
});

// Search lives in History and waits for something to search; its centering is checked once transcripts exist.
test("the toolbar shows no page title and no search on Home", async () => {
  await expect(page.locator(".toolbar-search")).toHaveCount(0);
  expect((await page.locator(".desktop-toolbar h2").boundingBox())!.width).toBeLessThanOrEqual(1);
});

test("desktop pages navigate immediately, preserve capture DOM and return focus with Escape", async () => {
  const workspace = await page.locator(".workspace-stack").elementHandle();
  const settings = page.getByRole("button", { name: "הגדרות", exact: true });
  await settings.click();
  await expect(page.getByRole("heading", { name: "הגדרות", exact: true })).toBeFocused();
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".workspace-stack")).not.toBeVisible();
  expect(await workspace!.evaluate(el => el.isConnected)).toBe(true);
  // Settings is a lazy chunk: on a slow machine its loading mark, which does animate, shows first.
  await expect(page.locator(".loading-mark")).toHaveCount(0);
  expect(await page.locator(".desktop-main").evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === "running").length)).toBe(0);
  await page.keyboard.press("Escape"); await expect(settings).toBeFocused();
  await settings.press("Enter"); await expect(settings).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settings.click();
  expect(await page.locator(".desktop-main").evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === "running").length)).toBe(0);
  await page.keyboard.press("Escape"); await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("the dictionary has its own sidebar screen and left Settings", async ({}, info) => {
  const dictionary = page.getByRole("button", { name: he.dictionaryTitle, exact: true });
  await dictionary.click();
  await expect(page.getByRole("heading", { name: he.dictionaryTitle, exact: true })).toBeFocused();
  await expect(dictionary).toHaveAttribute("aria-current", "page");
  for (const name of Object.values(he.termPackNames)) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: he.termPackNames.dev, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: he.termPackNames.design, exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByLabel(he.dictionaryHeard)).toBeVisible();
  expect(await page.locator('[data-sf-symbol="character.book.closed.fill.he"]').evaluate(el => getComputedStyle(el).maskImage)).not.toContain("undefined");
  await page.screenshot({ path: info.outputPath("dictionary.png") });
  await page.getByRole("button", { name: he.settings, exact: true }).click();
  await expect(page.getByRole("heading", { name: he.settings, exact: true })).toBeFocused();
  await expect(page.getByText(he.builtInTerms)).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("System fonts, SF Symbols, narrow windows and enlarged text stay usable", async ({}, info) => {
  expect(await page.locator(".desktop-sidebar h1").evaluate(el => getComputedStyle(el).fontFamily)).toContain("system-ui");
  expect(await page.locator('[data-sf-symbol="gearshape.fill"]').evaluate(el => getComputedStyle(el).maskImage)).not.toContain("undefined");
  for (const width of [MIN_WINDOW_SIZE.width, 320]) {
    await app.evaluate(({ BrowserWindow }, width) => { const main = BrowserWindow.getAllWindows()[0]; main.setMinimumSize(320, 560); main.setSize(width, 700); }, width);
    for (const fontSize of ["", "200%"]) {
      await page.evaluate(value => document.documentElement.style.fontSize = value, fontSize);
      await page.getByRole("button", { name: he.startRecording, exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const main = page.locator(".instrument-content");
      expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`main-${width}-${fontSize ? "large" : "normal"}.png`) });
      await page.getByRole("button", { name: "הגדרות", exact: true }).click();
      expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`settings-${width}-${fontSize ? "large" : "normal"}.png`) });
      await page.keyboard.press("Escape");
    }
  }
  await page.evaluate(() => document.documentElement.style.fontSize = "");
  await app.evaluate(({ BrowserWindow }, size) => { const main = BrowserWindow.getAllWindows()[0]; main.setSize(size.width, size.height); main.setMinimumSize(720, 560); }, DEFAULT_WINDOW_SIZE);
});

test("new transcripts appear in the home grid and open their complete history record", async ({}, info) => {
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: he.startRecording, exact: true }).click();
    await page.getByRole("button", { name: he.stopRecording, exact: true }).click();
    await expect(page.locator(".transcript-content")).toContainText("תמלול דמה מקומי");
    // The transcript open above the list is left out of it until it is closed.
    await expect(page.locator(".transcript-preview")).toHaveCount(index);
    await page.getByRole("button", { name: "סגירת תמלול אחרון" }).click();
    await expect(page.locator(".transcript-preview")).toHaveCount(index + 1);
  }
  await page.screenshot({ path: info.outputPath("home-grid.png") });
  await page.locator(".transcript-preview").nth(1).click();
  await expect(page.getByRole("heading", { name: "היסטוריה", exact: true })).toBeFocused();
  await expect(page.locator(".history-reader")).toContainText("תמלול דמה מקומי");
  await expect(page.locator('.history-browser [aria-pressed="true"]')).toBeVisible();
  const toolbar = (await page.locator(".desktop-toolbar").boundingBox())!;
  const search = (await page.locator(".toolbar-search").boundingBox())!;
  expect(search.x + search.width / 2).toBeCloseTo(toolbar.x + toolbar.width / 2, 0);
  expect(await page.locator(".instrument-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("history-reader.png") });
  for (const width of [560, 320]) {
    await app.evaluate(({ BrowserWindow }, width) => { const main = BrowserWindow.getAllWindows()[0]; main.setMinimumSize(320, 560); main.setSize(width, 700); }, width);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await page.getByRole("button", { name: he.delete, exact: true }).scrollIntoViewIfNeeded();
    expect(await page.locator(".instrument-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`history-${width}-large.png`) });
  }
  await page.evaluate(() => document.documentElement.style.fontSize = "");
  await app.evaluate(({ BrowserWindow }, size) => { const main = BrowserWindow.getAllWindows()[0]; main.setSize(size.width, size.height); main.setMinimumSize(720, 560); }, DEFAULT_WINDOW_SIZE);
  // Search lives in History.
  await page.getByRole("button", { name: he.history, exact: true }).click();
  await page.getByPlaceholder("חיפוש בתמלולים").fill("אין תוצאה כזאת");
  await expect(page.locator(".history-browser .history-empty")).toContainText(he.searchNoResults("אין תוצאה כזאת"));
  await page.getByRole("button", { name: "ניקוי שדה החיפוש" }).click();
  await page.getByRole("button", { name: he.workspace, exact: true }).click();
  await expect(page.locator(".transcript-preview")).toHaveCount(3);
  await page.reload();
  await expect(page.locator(".transcript-preview")).toHaveCount(3);
  await expect(page.locator(".transcript-tray")).toHaveCount(0);
});

// The mock repository stands in for SQLite here; the real migration and repository are covered by unit tests.
test("corrections are saved through IPC, survive a reload and can be undone", async () => {
  await page.locator(".transcript-preview").first().click();
  const reader = page.locator(".history-reader");
  await reader.getByRole("button", { name: "עריכה", exact: true }).click();
  const field = reader.locator("textarea").first();
  await expect(field).toBeFocused();
  await field.fill("טקסט שתוקן ידנית");
  await field.press("Meta+s");
  await expect(reader.locator(".transcript-text")).toContainText("טקסט שתוקן ידנית");
  await expect(reader.getByRole("button", { name: "עריכה", exact: true })).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: he.history, exact: true }).click();
  await expect(reader.locator(".transcript-text")).toContainText("טקסט שתוקן ידנית");
  await reader.getByRole("button", { name: "שחזור המקור", exact: true }).click();
  await expect(reader.getByRole("button", { name: he.reset, exact: true })).toBeFocused();
  await reader.getByRole("button", { name: "שחזור", exact: true }).click();
  await expect(reader.locator(".transcript-text")).toContainText("תמלול דמה מקומי");
  await expect(reader.getByRole("button", { name: "שחזור המקור", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a real file dropped on the file cell is transcribed, and an unsupported one is refused", async () => {
  const folder = mkdtempSync(join(tmpdir(), "meluli-drop-"));
  const drop = async (path: string) => {
    await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.id = "drop-source"; input.hidden = true; document.body.append(input); });
    await page.locator("#drop-source").setInputFiles(path);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#drop-source")!;
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(input.files![0]!);
      document.querySelector(".quick-action")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
      input.remove();
    });
  };
  writeFileSync(join(folder, "notes.txt"), "not audio");
  writeFileSync(join(folder, "drop-test.m4a"), "synthetic audio");
  await drop(join(folder, "notes.txt"));
  await expect(page.locator(".notice-toast").filter({ hasText: he.importAudioFailed })).toBeVisible();
  await page.getByRole("button", { name: "סגירת הודעה" }).click();
  await drop(join(folder, "drop-test.m4a"));
  await expect(page.locator(".transcript-content")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".transcript-channel")).toContainText("drop-test");
  rmSync(folder, { recursive: true, force: true });
  await page.locator(".transcript-close").click();
});

test("a bad YouTube link is refused in Hebrew and the field clears cleanly", async ({}, info) => {
  const field = page.getByRole("textbox", { name: he.youtubeUrlPlaceholder });
  await field.fill("not a link");
  await field.press("Enter");
  await expect(page.locator(".youtube-helper")).toHaveText(he.youtubeInvalidUrl);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  await page.screenshot({ path: info.outputPath("youtube-invalid.png") });
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
});
