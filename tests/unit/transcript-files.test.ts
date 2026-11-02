/* @vitest-environment node */
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAllTranscripts, deleteTranscript, writeTranscriptMirror } from "@main/services/transcript-files";
import type { TranscriptRecord } from "@shared/types";

const id = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const other = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const record = (recordId: string, createdAt = 1_700_000_000_000) => ({ id: recordId, createdAt, text: "שלום" }) as TranscriptRecord;

let root: string;
let transcriptsDir: string;
let backups: string;
const repository = (rows: TranscriptRecord[]) => ({
  getById: vi.fn((wanted: string) => rows.find((row) => row.id === wanted) ?? null),
  delete: vi.fn((wanted: string) => rows.some((row) => row.id === wanted)),
  deleteAll: vi.fn(() => true)
});
const database = (rows: TranscriptRecord[]) => ({ transcriptRepository: repository(rows), paths: { userDataPath: root, transcriptsDir } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meluli-transcript-files-"));
  transcriptsDir = join(root, "transcripts");
  backups = join(root, "backups");
  await mkdir(transcriptsDir);
  await mkdir(backups);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("deleting one transcript", () => {
  it("removes its mirror and no other file", async () => {
    await writeTranscriptMirror(record(id), transcriptsDir);
    await writeTranscriptMirror(record(other), transcriptsDir);
    await expect(deleteTranscript(database([record(id), record(other)]), id)).resolves.toBe(true);
    expect((await readdir(transcriptsDir)).join()).toContain(other);
    expect(await readdir(transcriptsDir)).toHaveLength(1);
  });

  it("still reports the delete when the mirror was already gone", async () => {
    await expect(deleteTranscript(database([record(id)]), id)).resolves.toBe(true);
  });

  it("leaves the mirror of a row the database did not delete", async () => {
    await writeTranscriptMirror(record(id), transcriptsDir);
    const failing = database([record(id)]);
    failing.transcriptRepository.delete.mockReturnValue(false);
    await expect(deleteTranscript(failing, id)).resolves.toBe(false);
    expect(await readdir(transcriptsDir)).toHaveLength(1);
  });
});

describe("deleting every transcript", () => {
  it("removes mirrors and migration backups, and only those", async () => {
    await writeTranscriptMirror(record(id), transcriptsDir);
    await writeFile(join(backups, "ivrit-menu-bar-before-v7-1700000000000.sqlite"), "fixture");
    const kept = ["2026-01-01T00-00-00-000Z-notes.txt", "my-export.srt", "notes.txt", `x${id}.txt`];
    for (const name of kept) await writeFile(join(transcriptsDir, name), "fixture");
    await writeFile(join(backups, "by-hand.sqlite"), "fixture");
    await expect(deleteAllTranscripts(database([]))).resolves.toBe(true);
    expect((await readdir(transcriptsDir)).sort()).toEqual([...kept].sort());
    expect(await readdir(backups)).toEqual(["by-hand.sqlite"]);
  });

  it("does not follow or remove a link or folder that carries a mirror's name", async () => {
    const name = `2026-01-01T00-00-00-000Z-${id}.txt`;
    const target = join(root, "elsewhere.txt");
    await writeFile(target, "fixture");
    await symlink(target, join(transcriptsDir, name));
    await mkdir(join(transcriptsDir, `2026-01-01T00-00-00-000Z-${other}.txt`));
    await deleteAllTranscripts(database([]));
    expect(await readdir(transcriptsDir)).toHaveLength(2);
    expect((await lstat(target)).isFile()).toBe(true);
  });

  it("works when neither folder exists", async () => {
    await rm(transcriptsDir, { recursive: true });
    await rm(backups, { recursive: true });
    await expect(deleteAllTranscripts(database([]))).resolves.toBe(true);
  });

  it("removes nothing when the database refuses", async () => {
    await writeTranscriptMirror(record(id), transcriptsDir);
    const failing = database([]);
    failing.transcriptRepository.deleteAll.mockImplementation(() => { throw new Error("locked"); });
    await expect(deleteAllTranscripts(failing)).rejects.toThrow("locked");
    expect(await readdir(transcriptsDir)).toHaveLength(1);
  });
});
