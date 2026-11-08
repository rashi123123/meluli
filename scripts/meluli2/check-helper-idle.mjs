#!/usr/bin/env node
// Fails when an idle native helper wakes up on its own. Starts each helper with no key held and no
// call running, then reads its context switches from /usr/bin/top. No permission prompt, microphone,
// tap or audio is involved: the hold-key helper is not told to watch, and the call helper only lists
// which apps use audio.
//
//   node scripts/meluli2/check-helper-idle.mjs [binDir=resources/bin] [seconds=20]
import { spawn, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { CALL_APPS } from "../../src/shared/call-apps.ts";

const bin = resolve(process.argv[2] ?? "resources/bin");
const seconds = Number(process.argv[3] ?? 20);
// The hold-key helper has no idle timer at all. The call helper looks again whenever any app on the
// Mac starts or stops an audio device, so other apps' sound leaves a small, varying rate.
const LIMITS = { "meluli-holdkey": 0.5, "meluli-callaudio": 5 };
// Registering CoreAudio listeners at launch costs a few thousand switches, so sampling starts later.

function switches(pid) {
  const text = execFileSync("/usr/bin/top", ["-l", "2", "-s", String(seconds), "-pid", String(pid), "-stats", "pid,csw"], { encoding: "utf8" });
  const values = [...text.matchAll(new RegExp(`^${pid}\\s+(\\d+)`, "gm"))].map((match) => Number(match[1]));
  if (values.length < 2) throw new Error(`no samples for ${pid}`);
  return (values[1] - values[0]) / seconds;
}

async function check(name, first) {
  const child = spawn(join(bin, name), [], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdout.resume();
  if (first) child.stdin.write(`${JSON.stringify(first)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  try {
    const rate = switches(child.pid);
    console.log(`${name}: ${rate.toFixed(2)} context switches/s idle`);
    return rate <= LIMITS[name];
  } finally {
    child.kill("SIGTERM");
  }
}

const results = await Promise.all([
  check("meluli-holdkey", null),
  check("meluli-callaudio", { type: "watch", prefixes: CALL_APPS.flatMap((app) => app.prefixes) })
]);
if (results.includes(false)) {
  console.error(`An idle helper exceeded its limit ${JSON.stringify(LIMITS)}. A listed call app playing audio also raises this.`);
  process.exit(1);
}
