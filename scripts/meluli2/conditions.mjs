#!/usr/bin/env node
// Records the conditions a measurement ran under: load, thermal and power state, and the busiest
// processes by name (executable name only, no arguments, so no paths or documents are recorded).
//   node scripts/meluli2/conditions.mjs <out-file> [label]
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
const [file, label = ""] = process.argv.slice(2);
const run = (cmd, args) => { try { return execFileSync(cmd, args).toString(); } catch { return ""; } };
const rows = run("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="]).trim().split("\n").map((line) => {
  const [pid, ppid, cpu, rss, ...comm] = line.trim().split(/\s+/);
  return { pid: +pid, ppid: +ppid, cpu: +cpu, rssMiB: Math.round(+rss / 1024), name: basename(comm.join(" ")) };
});
const meluli = rows.filter((r) => /meluli|electron/i.test(r.name));
const conditions = {
  at: new Date().toISOString(), label,
  loadavg: run("sysctl", ["-n", "vm.loadavg"]).trim(),
  thermal: run("pmset", ["-g", "therm"]).trim().split("\n").filter(Boolean),
  power: run("pmset", ["-g", "batt"]).trim().split("\n").filter(Boolean),
  processCount: rows.length,
  totalCpuPercent: Math.round(rows.reduce((a, r) => a + r.cpu, 0)),
  busiest: rows.sort((a, b) => b.cpu - a.cpu).slice(0, 15),
  meluliProcesses: meluli,
};
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(conditions, null, 2));
console.log(file);
