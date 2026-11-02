import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptRecord } from "@shared/types";
import type { AppPaths, TranscriptRepositoryLike } from "../db/database";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// The folder is also where exports are offered by default, so only exact generated names qualify.
const MIRROR_NAME = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-${UUID}\\.txt$`, "u");
const BACKUP_NAME = /^ivrit-menu-bar-before-v\d+-\d+\.sqlite$/u;

interface TranscriptStore {
  transcriptRepository: Pick<TranscriptRepositoryLike, "getById" | "delete" | "deleteAll">;
  paths: Pick<AppPaths, "userDataPath" | "transcriptsDir">;
}

function mirrorName(transcript: Pick<TranscriptRecord, "id" | "createdAt">): string {
  const safeTimestamp = new Date(transcript.createdAt).toISOString().replace(/[:.]/g, "-");
  return `${safeTimestamp}-${transcript.id}.txt`;
}

export async function writeTranscriptMirror(transcript: TranscriptRecord, transcriptsDir: string): Promise<void> {
  await mkdir(transcriptsDir, { recursive: true });
  await writeFile(join(transcriptsDir, mirrorName(transcript)), transcript.text, { encoding: "utf8", mode: 0o600 });
}

async function removeFiles(directory: string, matches: RegExp): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => matches.test(name)).map(async (name) => {
    const path = join(directory, name);
    if ((await lstat(path).catch(() => null))?.isFile()) await rm(path, { force: true });
  }));
}

/** The row is the record of what happened, so a copy that will not go never fails the delete. */
const warnCopiesLeft = () => console.warn("[TranscriptFiles] a copy of a deleted transcript could not be removed");

export async function deleteTranscript({ transcriptRepository, paths }: TranscriptStore, id: string): Promise<boolean> {
  const transcript = transcriptRepository.getById(id);
  const deleted = transcriptRepository.delete(id);
  if (deleted && transcript) await rm(join(paths.transcriptsDir, mirrorName(transcript)), { force: true }).catch(warnCopiesLeft);
  return deleted;
}

/** A running app has passed its migrations, so the backups no longer have a rollback to serve. */
export async function deleteAllTranscripts({ transcriptRepository, paths }: TranscriptStore): Promise<boolean> {
  const deleted = transcriptRepository.deleteAll();
  await Promise.all([
    removeFiles(paths.transcriptsDir, MIRROR_NAME),
    removeFiles(join(paths.userDataPath, "backups"), BACKUP_NAME)
  ]).catch(warnCopiesLeft);
  return deleted;
}
