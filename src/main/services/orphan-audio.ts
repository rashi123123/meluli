import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEMPORARY_AUDIO = new RegExp(`^(?:recording-\\d+|import-${UUID}|youtube-${UUID})\\.wav$`);
// Nothing locks the profile to one instance, so a recent file may belong to a running job.
const ORPHAN_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/** Removes temporary audio left by a crash. Only exact names directly inside `directory` qualify. */
export async function removeOrphanAudio(directory: string, now = Date.now()): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(names.filter(name => TEMPORARY_AUDIO.test(name)).map(async name => {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs >= ORPHAN_MIN_AGE_MS) await rm(path, { force: true }).catch(() => undefined);
  }));
}
