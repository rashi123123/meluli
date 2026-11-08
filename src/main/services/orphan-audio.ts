import { randomUUID } from "node:crypto";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type TemporaryAudioKind = "recording" | "import" | "youtube" | "flow-test";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// recording-<ms> is the name earlier versions used; files they left are still swept.
const TEMPORARY_AUDIO = new RegExp(`^(?:recording-\\d+|(?:recording|import|youtube|flow-test)-${UUID})\\.wav$`);

/** Where a job puts the audio it decodes for the worker. The sweep below knows every name made here. */
export function temporaryAudioPath(directory: string, kind: TemporaryAudioKind): string {
  return join(directory, `${kind}-${randomUUID()}.wav`);
}
// Nothing locks the profile to one instance, so a recent file may belong to a running job.
const ORPHAN_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/** Removes temporary audio left by a crash. Only exact names directly inside `directory` qualify. */
export async function removeOrphanAudio(directory: string, now = Date.now(), downloads = tmpdir()): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all([
    ...names.filter(name => TEMPORARY_AUDIO.test(name)).map(async name => {
      const path = join(directory, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs >= ORPHAN_MIN_AGE_MS) await rm(path, { force: true }).catch(() => undefined);
    }),
    removeOrphanDownloads(downloads, now)
  ]);
}

/** The folder a link import downloads into, under the system's temporary folder. */
export const LINK_DOWNLOAD_PREFIX = "ivrit-youtube-";
// mkdtemp adds six letters or digits; the mock run adds "mock-" first.
const LINK_DOWNLOAD = new RegExp(`^${LINK_DOWNLOAD_PREFIX}(?:mock-)?[A-Za-z0-9]{6}$`);
// Each of an import's two helper runs may take six hours; a folder untouched for a day is no live job's.
const DOWNLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes link-import folders a crash left behind. Only real folders with the exact generated name,
 * directly inside `root`, owned by this user and closed to others, and nothing in them written for a day:
 * a download still running keeps its folder.
 */
async function removeOrphanDownloads(root: string, now: number): Promise<void> {
  // The native host has no process.getuid; the home folder is this user's.
  const uid = process.getuid?.() ?? (await lstat(homedir()).catch(() => null))?.uid;
  if (uid === undefined) return;
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(names.filter(name => LINK_DOWNLOAD.test(name)).map(async name => {
    const folder = join(root, name);
    const info = await lstat(folder).catch(() => null);
    // mkdtemp makes the folder this user's alone; one that is not was not made by an import.
    if (!info?.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) return;
    const entries = await readdir(folder).catch(() => null);
    if (!entries) return;
    const times = await Promise.all(entries.map(entry => lstat(join(folder, entry)).then(item => item.mtimeMs, () => now)));
    if (now - Math.max(info.mtimeMs, ...times) < DOWNLOAD_MIN_AGE_MS) return;
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }));
}
