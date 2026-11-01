import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

let destination: string | null = null;
let operation: string | null = null;
// Sustained GPU work throttles a fanless Mac to a third of its speed, so each slow stage needs this beside it.
let thermalState: (() => string) | null = null;
/** Off unless a research container or MELULI_DICTATION_TIMING asks for it. No text/audio payloads. */
export function configurePipelineTrace(path: string | null, thermal: (() => string) | null = null): void { destination = path; thermalState = thermal; }
export function beginPipelineTrace(): void { if (destination) { operation = randomUUID(); pipelineTrace("pipeline", "start"); } }
export function pipelineTrace(stage: string, phase: string, detail: Record<string, string | number | boolean | null> = {}): void {
  if (!destination) return;
  const cpu = process.cpuUsage();
  try { appendFileSync(destination, JSON.stringify({ operation, stage, phase, thermal: thermalState?.() ?? null, atMs: Date.now(), atNs: process.hrtime.bigint().toString(), mainCpuUserUs: cpu.user, mainCpuSystemUs: cpu.system, ...detail }) + "\n", { mode: 0o600 }); }
  catch { /* Diagnostics must not change an insertion outcome or cause a retry. */ }
}
