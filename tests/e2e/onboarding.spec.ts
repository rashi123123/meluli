import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { closeApp, launchApp } from "./helpers/launch";
import type { IvritMenuBarApi } from "../../src/shared/preload-api";
import { DEFAULT_MODEL_FILENAME, DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE } from "../../src/shared/constants";
import { installTestMicrophone } from "./helpers/microphone";
import { he } from "../../src/shared/locale";

type AppGlobal = typeof globalThis & { ivritMenuBar: IvritMenuBarApi };
let app: ElectronApplication, page: Page, profile: string;
const faults: string[] = [];

test.beforeEach(async () => {
  faults.length = 0;
  profile = mkdtempSync(join(tmpdir(), "meluli-onboarding-"));
  ({ app, page } = await launchApp({ args: ["."], env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile }, colorScheme: "dark" }));
  page.on("pageerror", error => faults.push(error.message));
  await page.waitForURL(/index\.html/);
  await expect(page.getByText(he.onboardingWelcomeTitle)).toBeVisible();
});
test.afterEach(async () => {
  await closeApp(app);
  if (profile) rmSync(profile, { recursive: true, force: true });
  expect(faults, "No unhandled renderer exception during the flow").toEqual([]);
});

async function assertCardInsets() {
  if (await page.locator(".onboarding-channel").count()) {
    const geometry = await page.locator(".onboarding-step-body").evaluate(el => {
      const copy = el.querySelector(".onboarding-copy")!.getBoundingClientRect();
      const preview = el.querySelector(".onboarding-step-details")!.getBoundingClientRect();
      const style = getComputedStyle(el.querySelector(".onboarding-step-details > *")!);
      return { copy: { x: copy.x, right: copy.right, bottom: copy.bottom }, preview: { x: preview.x, right: preview.right, top: preview.top }, pad: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], width: innerWidth };
    });
    expect(new Set(geometry.pad).size).toBe(1);
    // Every setup step stacks its copy above the preview, both centred.
    expect((geometry.copy.x + geometry.copy.right) / 2).toBeCloseTo((geometry.preview.x + geometry.preview.right) / 2, 0);
    expect(geometry.preview.top).toBeGreaterThan(geometry.copy.bottom);
    await expect(page.locator(".desktop-sidebar")).toHaveCount(0);
    return;
  }
  const rows = await page.locator(".settings-rows > *").evaluateAll(items => items.map(item => {
    const style = getComputedStyle(item), rect = item.getBoundingClientRect();
    return { x: rect.x, right: rect.right, start: style.paddingInlineStart, end: style.paddingInlineEnd, top: style.paddingTop, bottom: style.paddingBottom };
  }));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.start).toBe(row.end); expect(row.top).toBe(row.bottom);
    expect(row.x).toBeCloseTo(rows[0].x, 0); expect(row.right).toBeCloseTo(rows[0].right, 0);
  }
}
async function activate() {
  await page.evaluate(async () => {
    const api = (globalThis as AppGlobal).ivritMenuBar;
    await api.model.download();
    await api.settings.set("onboarding", { phase: "activated", surface: "workspace", activatedAt: 1, completedOptionalActions: [], dismissedOptionalActions: [] });
  });
  await page.reload(); await expect(page.getByRole("button", { name: he.settings, exact: true })).toBeVisible();
}
async function screenshot(info: TestInfo, name: string) { await page.screenshot({ path: info.outputPath(`${name}.png`) }); }

test("onboarding opens with a split explanation and demo without a sidebar", async ({}, info) => {
  await screenshot(info, "welcome"); await assertCardInsets();
  const primary = page.locator('[data-onboarding-action="primary"]');
  const contrast = () => primary.evaluate(el => {
    const style = getComputedStyle(el);
    const luminance = (color: string) => {
      const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return values.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    };
    const fg = luminance(style.color), bg = luminance(style.backgroundColor);
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
  });
  expect(await contrast()).toBeGreaterThanOrEqual(4.5);
  await primary.hover();
  await expect(primary).toHaveCSS("background-color", "rgb(255, 255, 255)");
  expect(await contrast()).toBeGreaterThanOrEqual(4.5);
});
test("settings rows share symmetric insets and one edge", async ({}, info) => {
  await activate(); await page.getByRole("button", { name: he.settings, exact: true }).click();
  await expect(page.locator(".settings-rows").first()).toBeVisible();
  await screenshot(info, "settings"); await assertCardInsets();
});


async function mockPermissionRequests() {
  // Replace only test-process permission responses; no OS permission prompt or production hook is added.
  await app.evaluate(({ ipcMain }) => {
    let current = "not-determined", requests = 0;
    ipcMain.removeHandler("permission:microphone-status");
    ipcMain.removeHandler("permission:request-microphone");
    ipcMain.handle("permission:microphone-status", () => current);
    ipcMain.handle("permission:request-microphone", () => { current = ++requests === 1 ? "denied" : "granted"; return current; });
  });
  await page.reload();
  await installTestMicrophone(page);
}
const settings = () => page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.settings.get());

test("onboarding handles denied permission, failed model install, retry and first transcription", async ({}, info) => {
  await mockPermissionRequests();
  const paths = await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.files.storagePaths());
  const blocker = join(paths.modelsDir, DEFAULT_MODEL_FILENAME);
  writeFileSync(blocker, "Test-only file blocking directory creation");
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  await expect(page.locator(".microphone-error")).toBeVisible();
  await assertCardInsets();
  // A denied microphone is fixed in System Settings, so the step's one action opens it.
  await expect(page.getByRole("button", { name: he.onboardingPasteOpenSettings, exact: true })).toBeVisible();
  expect((await settings()).onboarding.phase).toBe("needs_mic");
  await screenshot(info, "microphone-denied");
  // Granting it there and coming back refreshes the permission when the window regains focus,
  // and the step starts its check on its own.
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("permission:microphone-status"); ipcMain.handle("permission:microphone-status", () => "granted"); });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("המיקרופון עובד", { exact: true })).toBeVisible();
  expect((await settings()).onboarding.phase).toBe("needs_mic");
  await screenshot(info, "microphone-live");
  await page.getByRole("button", { name: he.continue, exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __microphoneFixture: { stops: number } }).__microphoneFixture.stops)).toBe(1);
  // The failure surfaces on Home, one screen past the click that started the download.
  await expect(page.getByRole("button", { name: he.retry, exact: true })).toBeVisible();
  expect((await settings()).modelState.downloadState).toBe("error");
  await screenshot(info, "model-error");
  // The status card already reports the failure, so no toast repeats it.
  await expect(page.getByRole("button", { name: "סגירת הודעה" })).toHaveCount(0);
  rmSync(blocker); await page.getByRole("button", { name: he.retry, exact: true }).click();
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  expect((await settings()).onboarding.phase).toBe("needs_first_transcript");
  await screenshot(info, "home-ready");
  await expect(page.getByText(he.onboardingFirstTranscriptTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.startRecording, exact: true }).click();
  await page.getByRole("button", { name: he.pauseRecording, exact: true }).click();
  await expect(page.getByRole("button", { name: he.resumeRecording, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: he.resumeRecording, exact: true }).click();
  await page.getByRole("button", { name: he.stopRecording, exact: true }).click();
  await expect(page.locator(".transcript-content").getByText("תמלול דמה מקומי")).toBeVisible();
  await expect.poll(async () => (await settings()).onboarding.phase).toBe("activated");
  await page.reload();
  await expect(page.getByText(he.onboardingWelcomeTitle)).not.toBeVisible();
  await expect(page.locator(".preview-title").getByText("תמלול דמה מקומי")).toBeVisible();
});

test("the floating recorder finishes setup, and the new keyboard paths work once activated", async () => {
  await installTestMicrophone(page);
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  await expect(page.getByText("המיקרופון עובד", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.continue, exact: true }).click();
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  await expect(page.getByText(he.onboardingFirstTranscriptTitle, { exact: true })).toBeVisible();

  const opened = app.waitForEvent("window");
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.overlay.open());
  const overlay = await opened;
  await expect(overlay.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  await overlay.getByRole("button", { name: he.startRecording, exact: true }).click();
  await overlay.getByRole("button", { name: he.stopRecording, exact: true }).click();
  await expect.poll(async () => (await settings()).onboarding.phase).toBe("activated");
  await expect(page.getByText(he.onboardingFirstTranscriptTitle, { exact: true })).toHaveCount(0);

  await page.bringToFront();
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("heading", { name: he.settings, exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.about, exact: true }).click();
  await expect(page.locator(".info-page-version")).toContainText(he.appVersion);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: he.settings, exact: true })).toBeVisible();
  await page.keyboard.press("Meta+f");
  const search = page.locator("#history-search");
  await expect(search).toBeFocused();
  await search.fill("דמה");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
});

test("basic setup is two screens, and back navigation after a granted permission can continue", async () => {
  await installTestMicrophone(page);
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  await expect(page.getByText("המיקרופון עובד", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.back, exact: true }).click();
  await expect(page.getByText(he.onboardingWelcomeTitle)).toBeVisible();
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  await expect(page.getByText(he.onboardingMicrophoneTitle, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: he.continue, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: he.continue, exact: true }).click();
  await expect(page.getByRole("heading", { name: "בית", exact: true })).toBeVisible();
  await expect(page.getByText(he.onboardingFirstTranscriptTitle, { exact: true })).toBeVisible();
});

test("a profile stored on the old hold key step resumes at the engine and can walk back", async ({}, info) => {
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.settings.set("onboarding", {
    phase: "needs_hold_key", surface: "flow", activatedAt: null, completedOptionalActions: [], dismissedOptionalActions: []
  }));
  await page.reload();
  await expect(page.getByText(he.onboardingModelTitle, { exact: true })).toBeVisible();
  await assertCardInsets();
  await page.getByRole("button", { name: he.onboardingContinueLater }).click();
  await expect(page.getByRole("button", { name: he.onboardingResumeSetup })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: he.onboardingResumeSetup }).click();
  await expect(page.getByText(he.onboardingModelTitle, { exact: true })).toBeVisible();
  await screenshot(info, "model-resumed");
  // Paste sits between the microphone and the engine.
  await page.getByRole("button", { name: he.back, exact: true }).click();
  await expect(page.getByText(he.onboardingPasteTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.back, exact: true }).click();
  await expect(page.getByText(he.onboardingMicrophoneTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.back, exact: true }).click();
  await expect(page.getByText(he.onboardingWelcomeTitle)).toBeVisible();
});

test("the welcome step has one way forward, and deferring later is persisted", async () => {
  await expect(page.getByRole("button", { name: he.onboardingContinueLater })).toHaveCount(0);
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  // The microphone step offers "not now" in place of "continue later".
  await page.getByRole("button", { name: he.onboardingNotNow, exact: true }).click();
  await page.reload();
  // The mock download finished behind the skipped step, so nothing is left to resume.
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  await expect(page.getByText(he.onboardingWelcomeTitle)).not.toBeVisible();
});

test("microphone failures explain themselves and recover without leaving the step", async ({}, info) => {
  const failWith = (name: string) => page.evaluate(name => Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => { throw new DOMException("Test failure", name); } }), name);
  const start = page.getByRole("button", { name: he.onboardingMicrophoneAction, exact: true });
  await failWith("NotFoundError");
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  for (const [name, message] of [["NotFoundError", "לא מצאנו את המיקרופון"], ["NotReadableError", "משתמשת בו"]]) {
    if (name !== "NotFoundError") { await failWith(name); await start.click(); }
    await expect(page.locator(".microphone-error")).toContainText(message);
    await screenshot(info, `microphone-${name}`);
    expect((await settings()).onboarding.phase).toBe("needs_mic");
  }
  await installTestMicrophone(page);
  await start.click();
  await expect(page.locator(".microphone-error")).toHaveCount(0);
  await expect(page.getByText("המיקרופון עובד", { exact: true })).toBeVisible();
  await expect.poll(() => page.getByRole("meter").getAttribute("aria-valuenow").then(Number)).toBeGreaterThan(0);
  await page.getByRole("button", { name: he.continue, exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __microphoneFixture: { stops: number } }).__microphoneFixture.stops)).toBe(1);
});

test("leaving the step during a live check releases the microphone", async () => {
  await installTestMicrophone(page);
  await page.getByRole("button", { name: he.onboardingStartSetup }).click();
  await expect(page.getByText("המיקרופון עובד", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.back, exact: true }).click();
  await expect(page.getByText(he.onboardingWelcomeTitle)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __microphoneFixture: { stops: number } }).__microphoneFixture.stops)).toBe(1);
});

test("onboarding split layout reflows with symmetric preview insets and reachable actions at large text", async ({}, info) => {
  for (const size of [DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, { width: 320, height: 700 }]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 560); window.setSize(size.width, size.height);
    }, size);
    for (const fontSize of ["", "200%"]) {
      await page.evaluate(value => document.documentElement.style.fontSize = value, fontSize);
      await assertCardInsets();
      await page.locator('[data-onboarding-action="primary"]').scrollIntoViewIfNeeded();
      const dimensions = await page.evaluate(() => {
        const main = document.querySelector(".instrument-content")!;
        const header = main.getBoundingClientRect();
        const mainStyle = getComputedStyle(main);
        const flow = document.querySelector(".onboarding-flow")!.getBoundingClientRect();
        const primary = document.querySelector('[data-onboarding-action="primary"]')!.getBoundingClientRect();
        const root = document.documentElement;
        return { headerX: header.x + parseFloat(mainStyle.paddingLeft), flowX: flow.x, headerRight: header.right - parseFloat(mainStyle.paddingRight), flowRight: flow.right, actionTop: primary.top, actionBottom: primary.bottom, height: innerHeight, overflow: root.scrollWidth > innerWidth };
      });
      expect(dimensions.flowX).toBeGreaterThanOrEqual(dimensions.headerX - 1);
      expect(dimensions.flowRight).toBeLessThanOrEqual(dimensions.headerRight + 1);
      expect(dimensions.overflow).toBe(false);
      await expect(page.locator(".onboarding-progress")).toHaveAttribute("aria-label", new RegExp(`^${he.onboardingSetupStepWelcome} · ${he.onboardingStepOfTotal.replace("{current}", "1").replace("{total}", "[23]")}$`));
      expect(await page.locator(".onboarding-primary-dock").evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(size.width - 24);
      expect(dimensions.actionTop).toBeGreaterThanOrEqual(0);
      expect(dimensions.actionBottom).toBeLessThanOrEqual(dimensions.height + 1);
      await screenshot(info, `welcome-${size.width}-${fontSize ? "large-text" : "normal"}`);
    }
  }
});

test("settings persist, native file import exports timed SRT, and history search/delete are consistent", async ({}, info) => {
  await activate();
  await page.getByRole("button", { name: he.settings, exact: true }).click();
  const initial = (await settings()).removeFillerWords;
  await page.getByRole("switch", { name: he.removeFillerWords, exact: true }).click();
  await expect(page.getByRole("switch", { name: he.removeFillerWords, exact: true })).toHaveAttribute("aria-checked", String(!initial));
  await expect.poll(async () => (await settings()).removeFillerWords).toBe(!initial);
  await page.reload(); await page.getByRole("button", { name: he.settings, exact: true }).click();
  await expect(page.getByRole("switch", { name: he.removeFillerWords, exact: true })).toHaveAttribute("aria-checked", String(!initial));
  await page.getByRole("button", { name: he.settingsResetTrigger, exact: true }).click();
  await expect(page.getByText(he.settingsResetConfirmTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: he.settingsResetCancel, exact: true }).click();
  expect((await settings()).onboarding.phase).toBe("activated");
  await page.keyboard.press("Escape");
  const wav = Buffer.alloc(44 + 32_000);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32_000, 40);
  const input = join(profile, "layout-test.wav"), output = join(profile, "layout-test.srt"); writeFileSync(input, wav);
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.input] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.output });
  }, { input, output });
  // A native menu cannot be clicked from the page, so the export menu picks SRT itself.
  // Other menus, such as the tray's, are built for real.
  await app.evaluate(({ Menu }, label) => {
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = ((template: Electron.MenuItemConstructorOptions[]) => {
      const pick = template.find(item => item.label === label)?.click as (() => void) | undefined;
      return pick ? { popup: () => pick() } : build(template);
    }) as unknown as typeof Menu.buildFromTemplate;
  }, he.downloadSrt);
  await page.getByRole("button", { name: he.importAudio, exact: true }).click();
  await expect(page.locator(".transcript-heading")).toContainText("layout-test.wav");
  await expect(page.locator(".transcript-content")).toContainText("layout-test");
  await page.getByRole("button", { name: he.exportMenu, exact: true }).click();
  await expect.poll(() => { try { return readFileSync(output, "utf8"); } catch { return ""; } }).toContain(" --> ");
  await page.getByRole("button", { name: he.history, exact: true }).click();
  await page.getByPlaceholder(he.searchPlaceholder).fill("אין-תוצאה-כזאת");
  await expect(page.locator(".history-browser .history-empty")).toContainText(he.searchNoResults("אין-תוצאה-כזאת"));
  await page.getByRole("button", { name: he.clearSearch, exact: true }).click();
  await expect(page.locator('[aria-pressed="true"]')).toBeVisible();
  await screenshot(info, "history-import");
  await page.getByRole("button", { name: he.delete, exact: true }).click();
  await expect(page.getByRole("group", { name: "מחיקת תמלול" }).getByRole("button", { name: "ביטול", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "מחיקת התמלול", exact: true }).click();
  await expect(page.getByText(he.historyEmpty, { exact: true })).toBeVisible();
  expect((await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.history.list(100))).items).toHaveLength(0);
});

test("welcome demonstration plays once, stays illustrative and has nothing to press", async ({}, info) => {
  const demo = page.getByRole("region", { name: "הדגמה של דיבור לטקסט" });
  await expect(demo).toHaveAttribute("data-state", "complete", { timeout: 6_000 });
  await expect(demo.getByRole("status")).toHaveText(/^משפט לדוגמה: /);
  await expect.poll(() => demo.evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === "running").length)).toBe(0);
  await expect(demo.getByRole("button")).toHaveCount(0);
  expect((await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.history.list())).items).toHaveLength(0);
  expect((await settings()).onboarding.phase).toBe("not_started");
  await screenshot(info, "welcome-demo-complete");
});

test("download hands off to Home immediately and progress never interrupts navigation", async ({}, info) => {
  await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.settings.set("onboarding", {
    phase: "needs_model", surface: "flow", activatedAt: null, completedOptionalActions: [], dismissedOptionalActions: []
  }));
  await page.reload();
  // Delay the real mock-download handler inside this disposable test process.
  // The original validated handler still performs all model persistence.
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown) => unknown> })._invokeHandlers.get("model:download");
    if (!original) throw new Error("Download handler unavailable");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(globalThis, { __releaseOnboardingDownload: release });
    ipcMain.removeHandler("model:download");
    ipcMain.handle("model:download", async event => { await gate; return original(event); });
  });
  await page.getByRole("button", { name: he.onboardingInstallAction, exact: true }).click();
  await expect(page.getByRole("heading", { name: "בית", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "הקלטה תתאפשר כשמנוע התמלול יסיים לרדת", exact: true })).toBeDisabled();
  await expect(page.locator(".workspace-setup-status")).toContainText("מורידים את מנוע התמלול");
  await page.getByRole("button", { name: he.settings, exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("model:download-progress", { percent: 25, bytesDownloaded: 25, totalBytes: 100 }));
  await expect(page.getByRole("heading", { name: he.settings, exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".background-download")).toHaveAttribute("aria-valuenow", "25");
  await expect(page.locator(".deck-status")).toHaveText(he.modelDownloading);
  await expect(page.locator(".deck-top .led")).not.toHaveAttribute("data-tone", "alert");
  await expect.poll(() => page.locator(".background-download .progress-track").evaluate(track =>
    track.firstElementChild!.getBoundingClientRect().width / track.getBoundingClientRect().width
  )).toBeCloseTo(.25, 2);
  await screenshot(info, "home-background-download");
  await app.evaluate(() => (globalThis as unknown as { __releaseOnboardingDownload: () => void }).__releaseOnboardingDownload());
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  await expect(page.locator(".workspace-stack > [role=status]")).toHaveText("מנוע התמלול מוכן. אפשר להתחיל להקליט.");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("model:download-progress", { percent: 100, bytesDownloaded: 100, totalBytes: 100 }));
  await expect(page.getByRole("button", { name: he.startRecording, exact: true })).toBeEnabled();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByText(he.onboardingFirstTranscriptTitle, { exact: true })).toBeVisible();
  expect((await settings()).onboarding.phase).toBe("needs_first_transcript");
  expect((await page.evaluate(() => (globalThis as AppGlobal).ivritMenuBar.history.list())).items).toHaveLength(0);
});
