import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, _electron as electron } from "@playwright/test";

// Kills only the main process this test launched, the way a crash or force quit ends it, and
// reports which of its own child processes outlive it and what CPU they use afterwards.
const scratch = resolve(process.env.MELULI_PERF_PROFILES ?? "tmp/meluli-2/profiles");
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
const rows = () => execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,comm="], { encoding: "utf8" }).trim().split("\n")
  .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean)
  .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), cpu: Number(m![3]), name: m![4].split("/").pop()! }));

test("children after the main process is killed", async () => {
  mkdirSync(scratch, { recursive: true });
  const profile = mkdtempSync(join(scratch, "orphan-"));
  const app = await electron.launch({ args: ["."], env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await settle(3_000);
  const main = app.process().pid!;
  const children = rows().filter((row) => row.ppid === main).map((row) => row.pid);
  console.log(`main ${main}, children ${children.length}`);
  process.kill(main, "SIGKILL");
  await settle(10_000);
  const survivors = rows().filter((row) => children.includes(row.pid));
  console.log(JSON.stringify(survivors.map(({ pid, ppid, cpu, name }) => ({ pid, ppid, cpu, name: name.replace(/^Electron /, "") }))));
  for (const survivor of survivors) { try { process.kill(survivor.pid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(profile, { recursive: true, force: true });
});
