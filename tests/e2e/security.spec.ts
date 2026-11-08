import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { closeApp, launchApp } from "./helpers/launch";
import { join } from "node:path";

let electronApp: ElectronApplication;
let page: Page;
let userDataPath: string;

test.beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), "meluli-e2e-"));
  ({ app: electronApp, page } = await launchApp({
    args: ["."],
    env: {
      ...process.env,
      IVRIT_E2E_MOCK: "1",
      MELULI_USER_DATA: userDataPath
    }
  }));

  await page.waitForFunction(() => Boolean((globalThis as typeof globalThis & { ivritMenuBar?: unknown }).ivritMenuBar));
});

test.afterAll(async () => {
  if (electronApp) {
    await closeApp(electronApp);
  }
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true });
});

test("main window preload omits overlay-only methods", async () => {
  const surface = await page.evaluate(() => ({
    hasMainHistory:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { history?: { list?: unknown } } }).ivritMenuBar?.history?.list === "function",
    hasMainOpenExternal:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { files?: { openExternal?: unknown } } }).ivritMenuBar?.files?.openExternal === "function",
    hasNavigateListener:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { app?: { onNavigate?: unknown } } }).ivritMenuBar?.app?.onNavigate === "function",
    hasOverlayHide:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { overlay?: { hide?: unknown } } }).ivritMenuBar?.overlay?.hide === "function",
    hasTextInsert:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { textInsert?: { intoFocusedField?: unknown } } }).ivritMenuBar?.textInsert?.intoFocusedField === "function",
    hasOverlayToggleListener:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { app?: { onRecordingToggleRequested?: unknown } } }).ivritMenuBar?.app?.onRecordingToggleRequested === "function"
  }));

  expect(surface.hasMainHistory).toBe(true);
  expect(surface.hasMainOpenExternal).toBe(true);
  expect(surface.hasNavigateListener).toBe(true);
  expect(surface.hasOverlayHide).toBe(false);
  expect(surface.hasTextInsert).toBe(false);
  expect(surface.hasOverlayToggleListener).toBe(false);
});

test("overlay window boots under sandbox with the expected bridge surface", async () => {
  const overlayCreated = electronApp.waitForEvent("window");
  await electronApp.evaluate(async ({ BrowserWindow }, paths: { preloadPath: string; rendererEntryPath: string }) => {
    const overlayWindow = new BrowserWindow({
      width: 332,
      height: 152,
      show: false,
      webPreferences: {
        preload: paths.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });

    await overlayWindow.loadFile(paths.rendererEntryPath, {
      query: {
        window: "overlay"
      }
    });
  }, {
    preloadPath: join(process.cwd(), "out/preload/index.cjs"),
    rendererEntryPath: join(process.cwd(), "out/renderer/index.html")
  });

  await expect.poll(async () => {
    return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  }).toBe(2);

  const overlayPage = await overlayCreated;
  await overlayPage.waitForFunction(() => Boolean((globalThis as typeof globalThis & { ivritMenuBar?: unknown }).ivritMenuBar));

  const surface = await overlayPage.evaluate(() => ({
    hasOverlayHide:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { overlay?: { hide?: unknown } } }).ivritMenuBar?.overlay?.hide === "function",
    hasTextInsert:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { textInsert?: { intoFocusedField?: unknown } } }).ivritMenuBar?.textInsert?.intoFocusedField === "function",
    hasOverlayToggleListener:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { app?: { onRecordingToggleRequested?: unknown } } }).ivritMenuBar?.app?.onRecordingToggleRequested === "function",
    hasMainHistory:
      typeof (globalThis as typeof globalThis & { ivritMenuBar?: { history?: { list?: unknown } } }).ivritMenuBar?.history?.list === "function"
  }));

  expect(surface.hasOverlayHide).toBe(true);
  expect(surface.hasTextInsert).toBe(true);
  expect(surface.hasOverlayToggleListener).toBe(true);
  expect(surface.hasMainHistory).toBe(false);
  await overlayPage.close();
});

test("generic openExternal rejects non-https URLs", async () => {
  const result = await page.evaluate(async () => {
    const browserGlobal = globalThis as typeof globalThis & {
      ivritMenuBar: {
        files: {
          openExternal(url: string): Promise<boolean>;
        };
      };
    };

    try {
      await browserGlobal.ivritMenuBar.files.openExternal("file:///tmp/not-allowed");
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  expect(result.ok).toBe(false);
  expect(result.message).toContain("Rejected external URL");
});

test("revealPath refuses anything but the storage folder", async () => {
  const revealed = await page.evaluate(async () => {
    const browserGlobal = globalThis as typeof globalThis & {
      ivritMenuBar: { files: { revealPath(path: string): Promise<boolean> } };
    };
    return browserGlobal.ivritMenuBar.files.revealPath("/etc/hosts");
  });

  expect(revealed).toBe(false);
});

test("window.open is denied at runtime", async () => {
  const beforeCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const wasDenied = await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      open(url?: string | URL, target?: string, features?: string): unknown | null;
    };

    return browserGlobal.open("https://example.com", "_blank") === null;
  });

  await page.waitForTimeout(300);
  const afterCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  expect(wasDenied).toBe(true);
  expect(afterCount).toBe(beforeCount);
});

test("unexpected navigation is denied at runtime", async () => {
  const initialUrl = page.url();

  await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      location: {
        href: string;
      };
    };

    browserGlobal.location.href = "https://example.com";
  });

  await page.waitForTimeout(300);
  expect(page.url()).toBe(initialUrl);
});
