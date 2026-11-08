import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type * as z from "zod";
import { ProcessLines } from "./process-lines";
import { terminateChild } from "./terminate-child";
import { minimalChildEnv } from "./child-env";

/** Ends a helper that is still running; a stuck one that ignores SIGTERM is killed after the grace period. */
export function endHelper(child: ChildProcessWithoutNullStreams, graceMs?: number): void {
  if (child.exitCode === null && child.signalCode === null) terminateChild(child, graceMs);
}

/**
 * A native helper that speaks one JSON object per line on stdout and reads one per line on stdin.
 * Anything it says that does not fit the schema ends it: its state can no longer be trusted.
 */
export function spawnLineHelper<Event>(
  executable: string,
  protocol: { schema: z.ZodType<Event>; maxLineLength: number },
  handlers: {
    /** Only lines from the helper the caller still holds. */
    isCurrent: (child: ChildProcessWithoutNullStreams) => boolean;
    onEvent: (child: ChildProcessWithoutNullStreams, event: Event) => void;
    /** Called once, with the exit code when there is one. */
    onGone: (child: ChildProcessWithoutNullStreams, code: number | null) => void;
  }
): ChildProcessWithoutNullStreams {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], env: minimalChildEnv(process.env) });
  const lines = new ProcessLines(child.stdout);
  child.stderr.resume();
  child.stdin.on("error", () => endHelper(child));
  // A failed spawn emits "error" and then "close"; the caller hears about it once.
  let gone = false;
  const goneOnce = (code: number | null) => {
    if (gone) return;
    gone = true;
    handlers.onGone(child, code);
  };
  child.once("error", () => goneOnce(null));
  child.once("close", (code) => {
    lines.close();
    goneOnce(code);
  });
  lines.on("line", (line) => {
    if (!handlers.isCurrent(child)) return;
    let event: Event;
    try {
      if (line.length > protocol.maxLineLength) throw new Error("line too long");
      event = protocol.schema.parse(JSON.parse(line));
    } catch {
      endHelper(child);
      return;
    }
    handlers.onEvent(child, event);
  });
  return child;
}

export function sendLine(child: ChildProcessWithoutNullStreams, message: object): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** At most three restarts a minute, each a second after the helper went away. */
export class RestartBudget {
  private recent: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  reset(): void {
    this.recent = [];
  }

  /** False when the helper has already failed too often to try again. */
  schedule(restart: () => void): boolean {
    const now = Date.now();
    this.recent = this.recent.filter((at) => now - at < 60_000);
    if (this.recent.length >= 3) return false;
    this.recent.push(now);
    this.timer = setTimeout(() => {
      this.timer = null;
      restart();
    }, 1000);
    this.timer.unref();
    return true;
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
