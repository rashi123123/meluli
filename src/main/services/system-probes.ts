import { rename, rm, statfs, writeFile } from "node:fs/promises";

/** Bytes an unprivileged process may still write on the volume that holds `path`. */
export async function diskFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return info.bavail * info.bsize;
}

/** Whether a process with this id exists. EPERM means it exists but belongs to someone else. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Where writeJsonAtomic stages `path` before the rename; named per process, so two processes never share it. */
export const atomicTemporaryPath = (path: string): string => `${path}.${process.pid}.tmp`;

/** Owner-only JSON that is either the old or the new version on disk, never half of one. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = atomicTemporaryPath(path);
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
