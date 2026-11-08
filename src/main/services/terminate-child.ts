import type { ChildProcess } from "node:child_process";

/**
 * Asks a child to end, and kills it if it is still running after the grace period: a stuck helper can
 * ignore SIGTERM. Returns whether SIGTERM was delivered.
 */
export function terminateChild(child: ChildProcess, graceMs = 1_000): boolean {
  const signaled = child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
  return signaled;
}
