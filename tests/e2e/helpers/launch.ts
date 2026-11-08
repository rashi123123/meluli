import { execFileSync } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;

const FIRST_WINDOW_MS = Number(process.env.MELULI_E2E_FIRST_WINDOW_MS) || 20_000;
const CLOSE_MS = 10_000;

/** Launches the app and waits for its first window. Should Electron still start without one, that copy is
 * described, killed and launched once more, so the hang never reaches the test. */
export async function launchApp(options: LaunchOptions): Promise<{ app: ElectronApplication; page: Page }> {
  // Every test profile shares Electron's saved window state. After a few launches end uncleanly, AppKit asks
  // whether to reopen windows in a modal no one can see, and every later launch waits on it. Xcode launches
  // without state restoration the same way.
  const launch = { ...options, args: [...(options.args ?? []), "-ApplePersistenceIgnoreState", "YES"] };
  for (let attempt = 1; ; attempt++) {
    const app = await electron.launch(launch);
    const output: string[] = [];
    const keep = (chunk: Buffer) => { output.push(chunk.toString()); };
    app.process().stdout?.on("data", keep);
    app.process().stderr?.on("data", keep);
    try {
      const page = await app.firstWindow({ timeout: FIRST_WINDOW_MS });
      app.process().stdout?.off("data", keep);
      app.process().stderr?.off("data", keep);
      return { app, page };
    } catch (error) {
      describeHang(app.process().pid, output.join(""), attempt);
      app.process().kill("SIGKILL");
      if (attempt >= 2) throw error;
    }
  }
}

/** Prints what a windowless launch was doing, so a hang on CI shows its cause in the log. */
function describeHang(pid: number | undefined, output: string, attempt: number) {
  const run = (command: string, args: string[]) => {
    try { return execFileSync(command, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }); }
    catch (error) { return `${command} failed: ${(error as Error).message}`; }
  };
  const lines = [`[e2e] launch ${attempt} opened no window within ${FIRST_WINDOW_MS} ms (pid ${pid ?? "unknown"})`];
  lines.push("[e2e] app output:", output.trim() ? output.trim().slice(-8_000) : "(none)");
  lines.push("[e2e] related processes:", run("/bin/ps", ["-axo", "pid,ppid,etime,stat,command"]).split("\n")
    .filter(line => /Electron|meluli-[a-z]+|asr-worker/.test(line) && !/\b(zsh|bash|sh) -c\b/.test(line)).join("\n") || "(none)");
  if (pid) {
    // The main thread is what failed to create the window; its stack names the call it is waiting in.
    const sample = run("/usr/bin/sample", [String(pid), "2", "-mayDie"]);
    const start = sample.indexOf("Call graph:");
    lines.push("[e2e] main-process sample:", (start >= 0 ? sample.slice(start) : sample).split("\n").slice(0, 120).join("\n"));
  }
  console.error(lines.join("\n"));
}

/** Closes the app, and kills it when it does not quit in time, so a stuck copy never holds up worker teardown. */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), CLOSE_MS); });
  const closed = app.close().then(() => false, () => false);
  if (await Promise.race([closed, stuck])) {
    console.error(`[e2e] app did not quit within ${CLOSE_MS} ms; killing pid ${app.process().pid ?? "unknown"}`);
    app.process().kill("SIGKILL");
  }
  clearTimeout(timer);
}
