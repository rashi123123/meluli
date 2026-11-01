import { contentTracing } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const PERF_AUDIT_DIR_NAME = "perf-audit";
const DEFAULT_STOP_DELAY_MS = 5_000;
const TRACE_CATEGORIES = [
  "toplevel",
  "startup",
  "blink.user_timing",
  "ipc",
  "mojom",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-v8.cpu_profiler"
] as const;

interface AuditMark {
  name: string;
  atMs: number;
  detail?: Record<string, unknown>;
}

class PerfAuditSession {
  private readonly startedAt = performance.now();
  private readonly marks: AuditMark[] = [];
  private traceOutputDir: string | null = null;
  private traceStarted = false;
  private stopTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;

  mark(name: string, detail?: Record<string, unknown>): void {
    this.marks.push({
      name,
      atMs: Math.round((performance.now() - this.startedAt) * 1000) / 1000,
      detail
    });
  }

  async start(userDataPath: string): Promise<void> {
    if (this.traceStarted) {
      return;
    }

    this.traceOutputDir = join(userDataPath, PERF_AUDIT_DIR_NAME);
    await mkdir(this.traceOutputDir, { recursive: true });

    await contentTracing.startRecording({
      included_categories: [...TRACE_CATEGORIES],
      recording_mode: "record-as-much-as-possible"
    });
    this.traceStarted = true;
    this.mark("content-tracing:started", {
      categories: TRACE_CATEGORIES.join(",")
    });
  }

  scheduleStop(reason: string, delayMs = DEFAULT_STOP_DELAY_MS): void {
    if (!this.traceStarted || this.stopPromise) {
      return;
    }

    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
    }

    this.stopTimer = setTimeout(() => {
      void this.stop(reason);
    }, delayMs);
  }

  async stop(reason: string): Promise<void> {
    if (!this.traceStarted) {
      return;
    }

    if (this.stopPromise) {
      return this.stopPromise;
    }

    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    this.mark("content-tracing:stopping", { reason });

    this.stopPromise = (async () => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputDir = this.traceOutputDir ?? process.cwd();
      const tracePath = join(outputDir, `trace-${timestamp}.json`);
      const marksPath = join(outputDir, `trace-${timestamp}.marks.json`);

      try {
        const recordedTracePath = await contentTracing.stopRecording(tracePath);
        this.traceStarted = false;
        await writeFile(
          marksPath,
          JSON.stringify(
            {
              recordedTracePath,
              marks: this.marks
            },
            null,
            2
          ),
          "utf8"
        );
        console.info("[PerfAudit] Trace saved", {
          tracePath: recordedTracePath,
          marksPath
        });
      } catch (error) {
        this.traceStarted = false;
        console.error("[PerfAudit] Failed to stop tracing", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    })();

    return this.stopPromise;
  }
}

const perfAudit = process.env.IVRIT_PERF_AUDIT === "1" ? new PerfAuditSession() : null;


export function markPerformanceAudit(name: string, detail?: Record<string, unknown>): void {
  perfAudit?.mark(name, detail);
}

export async function startPerformanceAudit(userDataPath: string): Promise<void> {
  if (!perfAudit) {
    return;
  }

  try {
    await perfAudit.start(userDataPath);
  } catch (error) {
    console.error("[PerfAudit] Failed to start tracing", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
}

export function schedulePerformanceAuditStop(reason: string, delayMs = DEFAULT_STOP_DELAY_MS): void {
  perfAudit?.scheduleStop(reason, delayMs);
}

export async function stopPerformanceAudit(reason: string): Promise<void> {
  await perfAudit?.stop(reason);
}
