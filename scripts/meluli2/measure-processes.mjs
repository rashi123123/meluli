#!/usr/bin/env node
// Samples one Meluli process tree: memory with /usr/bin/footprint, CPU, idle wakeups and the energy
// impact score with /usr/bin/top. Needs no root and changes nothing. It reads process metadata only:
// no window contents, audio, clipboard or text.
//
//   node scripts/meluli2/measure-processes.mjs --root <pid> --label <name> [--seconds 60] [--interval 5] [--out dir] [--extra pid,pid]
//
// --extra adds processes outside the tree, such as WebKit's, which launchd starts for an app.
//
// Memory: "combined" is footprint's total for the whole tree, which counts shared dirty pages once.
// Per-process phys_footprint values overlap with it and must not be added up. GPU memory the
// WindowServer or the kernel holds for the app is not attributed to the app by either tool.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]?.startsWith("--") ? "true" : all[index + 1]]);
  return pairs;
}, []));
const root = Number(args.root);
if (!Number.isInteger(root) || root <= 0) throw new Error("--root <pid> is required");
const label = args.label ?? "unlabelled";
const seconds = Number(args.seconds ?? 60);
const interval = Number(args.interval ?? 5);
const out = resolve(args.out ?? "tmp/meluli-2/results");
const extra = (args.extra ?? "").split(",").filter(Boolean).map(Number);

const run = (file, argv) => execFileSync(file, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function tree() {
  const rows = run("/bin/ps", ["-axo", "pid=,ppid=,comm="]).trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
  const members = new Map([[root, rows.find((row) => row.pid === root)]]);
  if (!members.get(root)) throw new Error(`process ${root} is not running`);
  for (const pid of extra) { const row = rows.find((entry) => entry.pid === pid); if (row) members.set(pid, row); }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) if (!members.has(row.pid) && members.has(row.ppid)) { members.set(row.pid, row); grew = true; }
  }
  return [...members.values()];
}

/** Names a process by role without recording personal paths. */
function role(command) {
  const name = command.split("/").pop();
  if (/Helper \(GPU\)/.test(command)) return "electron-gpu";
  if (/Helper \(Renderer\)/.test(command)) return "electron-renderer";
  if (/Helper \(Plugin\)/.test(command)) return "electron-plugin";
  if (/Helper$/.test(command)) return "electron-utility";
  if (/WebContent/.test(command)) return "webkit-content";
  if (/WebKit\.GPU/.test(command)) return "webkit-gpu";
  if (/Networking/.test(command)) return "webkit-network";
  if (/GPU/.test(command)) return "webkit-gpu";
  if (name.startsWith("meluli-")) return name;
  return command.includes(".app/Contents/MacOS/") ? "main" : name;
}

function footprint(pids) {
  const file = join(tmpdir(), `meluli-footprint-${process.pid}-${Date.now()}.json`);
  try {
    run("/usr/bin/footprint", ["-j", file, "-f", "bytes", ...pids.map(String)]);
    const data = JSON.parse(readFileSync(file, "utf8"));
    return {
      combinedBytes: data["total footprint"],
      processes: Object.fromEntries(data.processes.map((entry) => [entry.pid, entry.footprint]))
    };
  } finally {
    rmSync(file, { force: true });
  }
}

/** top's first sample has no interval behind it, so it is dropped. */
function topSamples(pids, count) {
  const argv = ["-l", String(count + 1), "-s", String(interval), "-stats", "pid,cpu,idlew,power,threads,csw"];
  for (const pid of pids) argv.push("-pid", String(pid));
  const text = run("/usr/bin/top", argv);
  const blocks = text.split(/\n(?=Processes:)/).slice(1);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const header = lines.findIndex((line) => /^PID\s+%CPU/.test(line.trim()));
    return lines.slice(header + 1).map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length >= 6 && /^\d+$/.test(cells[0]))
      .map(([pid, cpu, idlew, power, threads, csw]) => ({ pid: Number(pid), cpu: Number(cpu), idleWakeups: Number(idlew), power: Number(power),
        threads: Number(threads), contextSwitches: Number(csw.replace(/\D+$/, "")) }));
  });
}

/** top reports cumulative context switches. A sleeping thread that wakes switches in, so the delta
 * per second is the wakeup rate on a busy Mac, where IDLEW stays near zero because no core is idle. */
function withSwitchRates(samples) {
  const last = new Map();
  return samples.map((rows) => rows.map((row) => {
    const previous = last.get(row.pid);
    last.set(row.pid, row.contextSwitches);
    return { ...row, switchesPerSecond: previous === undefined ? null : (row.contextSwitches - previous) / interval };
  }));
}

function context() {
  const battery = run("/usr/bin/pmset", ["-g", "batt"]);
  const thermal = run("/usr/bin/pmset", ["-g", "therm"]);
  return {
    powerSource: /AC Power/.test(battery) ? "ac" : /Battery Power/.test(battery) ? "battery" : "unknown",
    thermalWarning: /No thermal warning level has been recorded/.test(thermal) ? "none-recorded" : thermal.trim().split("\n").slice(-1)[0],
    loadAverage: run("/usr/sbin/sysctl", ["-n", "vm.loadavg"]).trim(),
    os: run("/usr/bin/sw_vers", ["-productVersion"]).trim(),
    hardware: run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]).trim(),
    memoryBytes: Number(run("/usr/sbin/sysctl", ["-n", "hw.memsize"]).trim())
  };
}

const nearestRank = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
};

const startedAt = new Date().toISOString();
const before = tree();
const pids = before.map((entry) => entry.pid);
const memoryBefore = footprint(pids);
// One extra sample, because the first switch rate has nothing before it.
const samples = withSwitchRates(topSamples(pids, Math.max(1, Math.round(seconds / interval)) + 1)).slice(1);
const after = tree();
const memoryAfter = footprint(after.map((entry) => entry.pid));

const roles = Object.fromEntries(after.map((entry) => [entry.pid, role(entry.command)]));
const perSample = samples.map((rows) => ({
  cpu: rows.reduce((sum, row) => sum + row.cpu, 0),
  idleWakeupsPerSecond: rows.reduce((sum, row) => sum + row.idleWakeups, 0) / interval,
  switchesPerSecond: rows.reduce((sum, row) => sum + (row.switchesPerSecond ?? 0), 0),
  power: rows.reduce((sum, row) => sum + row.power, 0)
}));
const byRole = {};
for (const entry of after) {
  const name = roles[entry.pid];
  const rows = samples.map((sample) => sample.find((row) => row.pid === entry.pid)).filter(Boolean);
  byRole[`${name}:${entry.pid}`] = {
    footprintBytes: memoryAfter.processes[entry.pid] ?? null,
    cpuMedian: nearestRank(rows.map((row) => row.cpu), 0.5),
    idleWakeupsPerSecondMedian: nearestRank(rows.map((row) => row.idleWakeups / interval), 0.5),
    switchesPerSecondMedian: nearestRank(rows.map((row) => row.switchesPerSecond).filter((value) => value !== null), 0.5),
    threads: rows.at(-1)?.threads ?? null
  };
}

const result = {
  label, startedAt, endedAt: new Date().toISOString(), seconds, interval,
  percentile: "nearest rank, sorted[ceil(p*n)-1], over top intervals",
  context: context(),
  processCountBefore: before.length, processCountAfter: after.length,
  memory: {
    combinedBytesBefore: memoryBefore.combinedBytes,
    combinedBytesAfter: memoryAfter.combinedBytes,
    note: "footprint total across the tree; shared dirty counted once"
  },
  summary: {
    cpuPercentMedian: nearestRank(perSample.map((s) => s.cpu), 0.5),
    cpuPercentP95: nearestRank(perSample.map((s) => s.cpu), 0.95),
    idleWakeupsPerSecondMedian: nearestRank(perSample.map((s) => s.idleWakeupsPerSecond), 0.5),
    idleWakeupsPerSecondP95: nearestRank(perSample.map((s) => s.idleWakeupsPerSecond), 0.95),
    switchesPerSecondMedian: nearestRank(perSample.map((s) => s.switchesPerSecond), 0.5),
    switchesPerSecondP95: nearestRank(perSample.map((s) => s.switchesPerSecond), 0.95),
    energyImpactMedian: nearestRank(perSample.map((s) => s.power), 0.5)
  },
  processes: byRole,
  raw: samples.map((rows) => rows.map((row) => ({ ...row, role: roles[row.pid] ?? "exited" })))
};

mkdirSync(out, { recursive: true });
const file = join(out, `${startedAt.replace(/[:.]/g, "-")}-${label}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
const mb = (bytes) => (bytes / 1048576).toFixed(1);
console.log(`${label}: ${after.length} processes, combined ${mb(memoryAfter.combinedBytes)} MiB, `
  + `CPU p50 ${result.summary.cpuPercentMedian}%, switches p50 ${result.summary.switchesPerSecondMedian}/s, idle wakeups p50 ${result.summary.idleWakeupsPerSecondMedian}/s, energy p50 ${result.summary.energyImpactMedian}`);
for (const [name, entry] of Object.entries(byRole)) {
  console.log(`  ${name.padEnd(28)} ${entry.footprintBytes === null ? "-" : mb(entry.footprintBytes).padStart(7)} MiB  cpu ${entry.cpuMedian}  switches ${entry.switchesPerSecondMedian}/s  idle wakeups ${entry.idleWakeupsPerSecondMedian}/s`);
}
console.log(file);
