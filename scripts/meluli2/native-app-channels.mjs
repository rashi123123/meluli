#!/usr/bin/env node
// R4 in the native app (D20): the service channels a person reaches from the window, run through
// the app's own IPC by page-scripts/channels.js in the development profile. Save dialogs answer with
// a project path (MELULI_NATIVE_SAVE_PATHS) and the export format menu picks SRT
// (MELULI_NATIVE_MENU_CHOICES); nothing opens the microphone or pastes.
//   node scripts/meluli2/native-app-channels.mjs [--app path] [--youtube url] [--out dir]
// --youtube downloads and transcribes that public video, as the YouTube page does.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const app = resolve(option("--app", join(root, ".build/native-app-e2e/Meluli Native Test.app")));
const youtubeUrl = option("--youtube", null);
const out = option("--out", null);
const work = join(root, ".build/native-run/channels");
const diag = join(work, "diag");
const exportPath = join(work, "export.srt");
const binary = join(app, "Contents/MacOS/Meluli");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const appPid = () => { try { return Number(execFileSync("pgrep", ["-f", binary]).toString().trim().split("\n")[0]); } catch { return null; } };

if (appPid()) throw new Error("The test app is already running");
rmSync(work, { recursive: true, force: true });
mkdirSync(diag, { recursive: true });
const script = join(work, "channels.js");
writeFileSync(script, `const CONFIG = ${JSON.stringify({ exportPath, youtubeUrl })};\n${readFileSync(join(root, "scripts/meluli2/page-scripts/channels.js"), "utf8")}`);

execFileSync("open", ["-n", "-g", "--env", `MELULI_NATIVE_DIAGNOSTICS=${diag}`, "--env", `MELULI_NATIVE_LOG=${join(work, "app.log")}`,
  "--env", `MELULI_NATIVE_PAGE_SCRIPT=${script}`, "--env", `MELULI_NATIVE_SAVE_PATHS=${exportPath}`,
  "--env", "MELULI_NATIVE_MENU_CHOICES=2", app]);

// The helpers the app keeps while idle, seen from outside.
const children = new Set();
const resultPath = join(diag, "page-script.json");
const deadline = Date.now() + (youtubeUrl ? 540_000 : 180_000);
while (!existsSync(resultPath) && Date.now() < deadline) {
  const pid = appPid();
  if (pid) {
    try {
      for (const line of execFileSync("pgrep", ["-P", String(pid), "-l"]).toString().trim().split("\n")) children.add(line.replace(/^\d+\s+/, ""));
    } catch {}
  }
  await sleep(1000);
}
const page = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
const result = page?.result ?? {};
const steps = Object.fromEntries((result.steps ?? []).map((entry) => [entry.name, entry]));
const report = {
  seconds: page?.seconds ?? null,
  error: page?.error ?? null,
  steps: result.steps ?? [],
  youtube: result.youtube ?? null,
  youtubeError: result.youtubeError ?? null,
  exported: existsSync(exportPath) ? readFileSync(exportPath, "utf8").slice(0, 200) : null,
  children: [...children]
};

if (appPid()) {
  try { execFileSync("osascript", ["-e", `tell application id "${execFileSync("defaults", ["read", join(app, "Contents/Info"), "CFBundleIdentifier"]).toString().trim()}" to quit`]); } catch {}
  for (let index = 0; index < 20 && appPid(); index += 1) await sleep(250);
}
report.leftRunning = Boolean(appPid());

const ok = (name) => steps[name]?.ok === true;
report.checks = {
  everyStepRan: report.steps.length > 0 && report.steps.every((entry) => entry.ok),
  updatesOff: steps["app.state"]?.value?.update?.status === "off",
  editAndOriginal: steps["history.update"]?.value === true && steps["history.restoreOriginal"]?.value === true,
  search: steps["history.search"]?.value === true,
  keptAudio: !steps["recordings.audio"] || (steps["recordings.audio"].value?.header === "RIFF" && steps["recordings.audio"].value?.wave === "WAVE"),
  exported: ok("files.exportTranscript") && steps["files.exportTranscript"].value === true && Boolean(report.exported),
  youtubeRefused: String(steps["youtube.refused"]?.value ?? "").startsWith("refused"),
  youtube: youtubeUrl ? Boolean(report.youtube?.transcript?.text) : null,
  quit: !report.leftRunning
};
report.pass = Object.values(report.checks).every((value) => value === true || value === null);
const text = JSON.stringify(report, null, 2);
console.log(text);
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-channels.json`), `${text}\n`); }
process.exit(report.pass ? 0 : 1);
