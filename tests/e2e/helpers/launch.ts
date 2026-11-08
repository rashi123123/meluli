import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;

const FIRST_WINDOW_MS = 20_000;
const CLOSE_MS = 10_000;

/** Launches the app and waits for its first window. On a cold CI runner Electron now and then starts without ever
 * opening one; that copy is killed and the app launched once more, so the hang never reaches the test. */
export async function launchApp(options: LaunchOptions): Promise<{ app: ElectronApplication; page: Page }> {
  for (let attempt = 1; ; attempt++) {
    const app = await electron.launch(options);
    try {
      return { app, page: await app.firstWindow({ timeout: FIRST_WINDOW_MS }) };
    } catch (error) {
      app.process().kill("SIGKILL");
      if (attempt >= 2) throw error;
    }
  }
}

/** Closes the app, and kills it when it does not quit in time, so a stuck copy never holds up worker teardown. */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), CLOSE_MS); });
  const closed = app.close().then(() => false, () => false);
  if (await Promise.race([closed, stuck])) app.process().kill("SIGKILL");
  clearTimeout(timer);
}
