import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { IvritMenuBarApi } from "../../src/shared/preload-api";
import { he } from "../../src/shared/locale";
import { THEMES } from "../../src/shared/themes";
let app: ElectronApplication, page: Page, profile: string;
type AppGlobal = typeof globalThis & { ivritMenuBar: IvritMenuBarApi };
test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), "meluli-polish-"));
  app = await electron.launch({ args: ["."], env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile } });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean((globalThis as AppGlobal).ivritMenuBar));
  await expect(page.getByText(he.onboardingWelcomeTitle)).toBeVisible();
  await page.evaluate(async () => {
    const api = (globalThis as AppGlobal).ivritMenuBar;
    await api.model.download();
    await api.settings.set("onboarding", { phase: "activated", surface: "workspace", activatedAt: 1, completedOptionalActions: ["recording_shortcut", "overlay_accessibility"], dismissedOptionalActions: [] });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeVisible();
});
test.afterEach(async () => { await app?.close(); if (profile) rmSync(profile, { recursive: true, force: true }); });

test("enabled primary text has readable contrast and keyboard focus", async ({}, info) => {
  await page.getByRole("button", { name: he.settings, exact: true }).click();
  await page.locator("#recording-shortcut-editor").press("Control+Shift+K");
  const save = page.getByRole("button", { name: he.save, exact: true });
  await expect(save).toBeEnabled();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  const colors = await save.evaluate(el => {
    const style = getComputedStyle(el);
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
    const fg = luminance(style.color), bg = luminance(style.backgroundColor);
    return { fg: style.color, bg: style.backgroundColor, contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05), focus: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
  });
  await info.attach("primary-colors", { body: JSON.stringify(colors), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("settings-save.png") });
  expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
  expect(colors.focus).not.toBe("none"); expect(colors.outlineWidth).toBeGreaterThanOrEqual(2);
  await save.press("Enter");
  await expect(page.locator("#recording-shortcut-editor")).toBeFocused();
  await expect(save).not.toBeVisible();
  await page.getByRole("button", { name: he.settingsResetTrigger, exact: true }).click();
  await expect(page.getByRole("button", { name: he.settingsResetCancel, exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: he.settingsResetTrigger, exact: true })).toBeFocused();
  await expect(page).toHaveTitle("הגדרות — מלולי");
});

test("a job finishing in the background leaves the reader and the editor alone", async () => {
  const opened = { id: "open-document", createdAt: Date.now(), sourceType: "imported_file", importedFileName: "פתוח.wav", text: "המסמך הפתוח." };
  const deliver = (transcript: typeof opened, items: Array<typeof opened>) => app.evaluate(({ BrowserWindow, ipcMain }, { transcript, items }) => {
    ipcMain.removeHandler("history:list");
    ipcMain.handle("history:list", () => ({ items, nextCursor: null }));
    BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("window=overlay"))!.webContents.send("transcription:complete", { transcript });
  }, { transcript, items });
  await deliver(opened, [opened]);
  await page.getByRole("button", { name: he.history, exact: true }).click();
  await page.getByRole("button", { name: "עריכה", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "טקסט התמלול" });
  await editor.fill("תיקון באמצע");
  const finished = { ...opened, id: "finished-in-background", createdAt: opened.createdAt + 1, importedFileName: "חדש.wav", text: "תמלול שהסתיים ברקע." };
  await deliver(finished, [finished, opened]);
  await expect(page.locator(".history-row", { hasText: "חדש" })).toBeVisible();
  await expect(page.locator(".desktop-toolbar h2")).toHaveText(he.history);
  await expect(editor).toHaveValue("תיקון באמצע");
  await expect(editor).toBeFocused();
});

test("a job too short to show its processing state still opens its result", async () => {
  const transcript = { id: "instant-job", createdAt: Date.now(), sourceType: "imported_file", importedFileName: "מהיר.wav", text: "תמלול מהיר." };
  await app.evaluate(({ BrowserWindow, ipcMain }, transcript) => {
    ipcMain.removeHandler("history:list");
    ipcMain.handle("history:list", () => ({ items: [transcript], nextCursor: null }));
    BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("window=overlay"))!.webContents.send("transcription:complete", { transcript });
  }, transcript);
  await expect(page.locator(".transcript-heading")).toContainText("מהיר.wav");
});

test("long result metadata and clipboard failure reflow at narrow and enlarged sizes", async ({}, info) => {
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    main.webContents.send("app:state", { status: "processing", timerStartedAt: null, activeSourceType: "imported_file" });
  });
  await expect(page.locator(".state-processing")).toBeVisible();
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const transcript = {
      id: "polish-fixture", createdAt: Date.now(), sourceType: "imported_file",
      importedFileName: "סיכום שיחה על עיצוב והקלטות — " + "LongFileNameWithoutSpaces".repeat(7) + ".wav",
      text: "טקסט בדיקה בלבד. " + "משפט בעברית עם English ו־123 לבדיקת קריאות וגלישת שורות. ".repeat(30),
      durationMs: 90_000, segments: [{ start: 0, end: 1, text: "טקסט בדיקה בלבד." }]
    };
    ipcMain.removeHandler("history:list");
    ipcMain.handle("history:list", () => ({ items: [transcript], nextCursor: null }));
    main.webContents.send("transcription:complete", { transcript });
    main.webContents.send("app:state", { status: "idle", timerStartedAt: null });
  });
  await expect(page.locator(".transcript-content")).toContainText("טקסט בדיקה בלבד");
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("clipboard:write-text");
    ipcMain.handle("clipboard:write-text", () => { throw new Error("Synthetic clipboard denial"); });
  });
  await page.getByRole("button", { name: he.copy, exact: true }).click();
  for (const width of [560, 320]) {
    await app.evaluate(({ BrowserWindow }, width) => { const main = BrowserWindow.getAllWindows()[0]; main.setMinimumSize(320, 560); main.setSize(width, 700); }, width);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    const retry = page.getByRole("button", { name: /ההעתקה לא הצליחה/ });
    await retry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`result-${width}-large.png`) });
    const size = await page.locator(".instrument-content").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    const button = await retry.boundingBox();
    expect(button!.x).toBeGreaterThanOrEqual(0);
    expect(button!.x + button!.width).toBeLessThanOrEqual(width);
    expect(await page.locator(".transcript-text p").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("32px");
    await retry.press("Tab");
  }
});

test("real Electron zoom preserves navigation and settings controls", async ({}, info) => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
  await page.getByRole("button", { name: he.settings, exact: true }).click();
  await expect(page.getByRole("heading", { name: he.settings, exact: true })).toBeFocused();
  const controls = page.getByRole("switch");
  for (let index = 0; index < await controls.count(); index++) {
    const control = controls.nth(index);
    await control.focus();
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    expect(await control.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
  }
  expect(await page.locator(".instrument-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("settings-real-zoom-200.png") });
  await info.attach("accessibility-tree", { body: await page.locator("body").ariaSnapshot(), contentType: "text/plain" });
});


test("sidebar aligns navigation, identifies the active page, and reflows while recording", async ({}, info) => {
  const sidebar = page.locator(".desktop-sidebar");
  const rows = sidebar.locator('button[data-slot="button"]');
  const geometry = await rows.evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button), rect = button.getBoundingClientRect();
    const icon = button.querySelector<HTMLElement>(".sf-symbol")!;
    return { x: rect.x, width: rect.width, height: rect.height, left: style.paddingLeft, right: style.paddingRight, icon: icon.getBoundingClientRect().right, mask: getComputedStyle(icon).maskImage };
  }));
  // Home, History, Dictionary and Actions, then Settings at the foot.
  expect(geometry).toHaveLength(5);
  for (const row of geometry) {
    expect(row.left).toBe(row.right);
    expect(row.x).toBeCloseTo(geometry[0].x, 0);
    expect(row.width).toBeCloseTo(geometry[0].width, 0);
    expect(row.height).toBeCloseTo(geometry[0].height, 0);
    expect(row.icon).toBeCloseTo(geometry[0].icon, 0);
    expect(row.mask).not.toContain("undefined");
  }
  await sidebar.getByRole("button", { name: he.settings, exact: true }).click();
  await page.locator(".settings-links").getByRole("button", { name: he.about, exact: true }).click();
  await expect(sidebar.getByRole("button", { name: he.settings, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: he.aboutPageTitle, exact: true })).toBeFocused();
  await sidebar.getByRole("button", { name: he.settings, exact: true }).click();
  await page.locator(".settings-links").getByRole("button", { name: he.privacy, exact: true }).click();
  await expect(page.getByRole("heading", { name: he.privacyPageTitle, exact: true })).toBeFocused();
  await expect(page.locator("#main-content")).toHaveJSProperty("scrollTop", 0);
  await sidebar.getByRole("button", { name: he.settings, exact: true }).click();
  await expect(page.locator(".settings-page").getByText(he.settingsResetEverything, { exact: true }).first()).toBeAttached();
  await page.screenshot({ path: info.outputPath("sidebar-desktop.png") });
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    main.webContents.send("app:state", { status: "recording", timerStartedAt: Date.now(), activeSourceType: "microphone" });
    main.setMinimumSize(320, 560); main.setSize(320, 700);
  });
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  await expect(page.locator(".nav-operation-status")).toHaveText(he.recording);
  for (let index = 0; index < await rows.count(); index++) {
    const rect = await rows.nth(index).boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
  }
  await expect(page.locator(".nav-operation-dot")).toBeVisible();
  const rail = await sidebar.boundingBox();
  const brand = await sidebar.locator(".sidebar-brand-mark").boundingBox();
  const navigation = await sidebar.locator(".desktop-navigation").boundingBox();
  const utilities = await sidebar.locator(".sidebar-footer").boundingBox();
  // The narrow rail stacks brand, navigation and utilities without covering each other.
  expect(navigation!.y).toBeGreaterThanOrEqual(brand!.y + brand!.height);
  expect(utilities!.y).toBeGreaterThanOrEqual(navigation!.y + navigation!.height);
  for (const box of [brand!, navigation!, utilities!]) {
    expect(box.x).toBeGreaterThanOrEqual(rail!.x);
    expect(box.x + box.width).toBeLessThanOrEqual(rail!.x + rail!.width);
  }
  await page.screenshot({ path: info.outputPath("sidebar-320-large-recording.png") });
});

test("the theme picker drives the native theme and survives a reload", async () => {
  await page.getByRole("button", { name: he.settings, exact: true }).click();
  await expect(page.getByRole("radio", { name: THEMES.system.label })).toBeChecked();
  await page.getByRole("radio", { name: THEMES["solarized-light"].label }).click({ force: true });
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "solarized-light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "solarized-light");
  await page.getByRole("button", { name: he.settings, exact: true }).click();
  await expect(page.getByRole("radio", { name: THEMES["solarized-light"].label })).toBeChecked();
  await page.getByRole("radio", { name: THEMES["meluli-dark"].label }).click({ force: true });
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});
