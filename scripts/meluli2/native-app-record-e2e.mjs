#!/usr/bin/env node
// The window's record button in the native app (D20), run without a person. The page script
// (page-scripts/window-record.js) sets the input to one named virtual device, presses record, and
// returns the saved transcript; this script plays the consented fixture into that device once the
// page has opened it. Window recordings never paste.
//
// Guard: if any other input on the Mac is seen open twice in a row (half a second apart), the app is
// killed before it can save anything, so a fallback to the default input never records the room.
// Inputs other programs already had open when the run started are left out of the guard.
//
//   node scripts/meluli2/native-app-record-e2e.mjs [--app path] [--device ZoomAudioDevice] [--delay ms] [--out dir]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const app = resolve(option("--app", join(root, ".build/native-app-e2e/Meluli Native Test.app")));
const device = option("--device", "ZoomAudioDevice");
const out = option("--out", null);
// The virtual device drops a player that starts within about 2 s of the page opening the input
// (MEASURED: the capture went silent 1.25 s into the fixture), so playback waits 3 s.
const delay = Number(option("--delay", "3000"));
// Build it with: swiftc -O -o .build/mic-selftest/player native/tests/audio-player.swift
const player = option("--player", join(root, ".build/mic-selftest/player"));
const work = join(root, ".build/native-run");
const fixture = join(work, "fixture.wav");
const diag = join(work, "diag");
const expected = "שלום, אני רוצה לקבוע פגישה מחר בשעה 22:30 עם דנה ועם יוסי, תודה רבה.";
const binary = join(app, "Contents/MacOS/Meluli");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const words = (text) => String(text).replace(/[.,!?״"]/g, "").split(/\s+/).filter(Boolean);
const overlap = (got, want) => { const have = new Set(words(got)); const list = words(want); return list.filter((word) => have.has(word)).length / list.length; };
const running = (name) => JSON.parse(execFileSync(player, ["--running", name]).toString()).running === true;
const openInputs = () => JSON.parse(execFileSync(player, ["--inputs"]).toString()).filter((entry) => entry.running).map((entry) => entry.name);
const appRunning = () => { try { execFileSync("pgrep", ["-f", binary]); return true; } catch { return false; } };

for (const path of [app, player, fixture]) if (!existsSync(path)) throw new Error(`Missing ${path}`);
if (appRunning()) throw new Error("The test app is already running");
rmSync(diag, { recursive: true, force: true });
mkdirSync(diag, { recursive: true });

execFileSync("open", ["-n", "-g", "--env", `MELULI_NATIVE_DIAGNOSTICS=${diag}`, "--env", `MELULI_NATIVE_LOG=${join(work, "app.log")}`,
  "--env", `MELULI_NATIVE_PAGE_SCRIPT=${join(root, "scripts/meluli2/page-scripts/window-record.js")}`, app]);

const busyBefore = openInputs();
if (busyBefore.includes(device)) throw new Error(`${device} is already in use`);
const report = { device, busyBefore, player: null, deviceOpened: false, killed: null };
const resultPath = join(diag, "page-script.json");
let playing = null;
let guardHits = 0;
const deadline = Date.now() + 240_000;
while (!existsSync(resultPath) && Date.now() < deadline) {
  const others = openInputs().filter((name) => name !== device && !busyBefore.includes(name));
  guardHits = others.length ? guardHits + 1 : 0;
  if (guardHits >= 2) {
    execFileSync("pkill", ["-9", "-f", binary]);
    report.killed = `${others.join(", ")} opened`;
    break;
  }
  if (!playing && running(device)) {
    report.deviceOpened = true;
    await sleep(delay);
    playing = new Promise((done) => {
      const child = spawn(player, [device, fixture], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.on("exit", (code) => { try { done({ code, ...JSON.parse(output) }); } catch { done({ code, output }); } });
    });
  }
  await sleep(500);
}
if (playing) report.player = await playing;
const page = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
const result = page?.result ?? {};
report.page = { seconds: page?.seconds, error: page?.error ?? result.error ?? null, chosen: result.chosen, probeSettings: result.probeSettings,
  stages: result.stages?.map((entry) => entry.stage), recordMs: result.recordMs, errors: result.errors, trackEvents: result.trackEvents };
report.transcript = result.transcript ?? null;
report.wordOverlap = result.transcript ? overlap(result.transcript.text, expected) : 0;

// Quit the way the menu does, then make sure nothing is left.
if (appRunning()) {
  try { execFileSync("osascript", ["-e", `tell application id "${execFileSync("defaults", ["read", join(app, "Contents/Info"), "CFBundleIdentifier"]).toString().trim()}" to quit`]); } catch {}
  for (let index = 0; index < 20 && appRunning(); index += 1) await sleep(250);
}
report.leftRunning = appRunning();
report.deviceOpenAfter = running(device);
report.pass = !report.killed && report.deviceOpened && report.player?.finished === true && report.wordOverlap >= 0.8
  && result.transcript?.sourceType === "microphone" && !report.leftRunning && !report.deviceOpenAfter;
const text = JSON.stringify(report, null, 2);
console.log(text);
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-window-record.json`), `${text}\n`); }
process.exit(report.pass ? 0 : 1);
