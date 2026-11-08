/* @vitest-environment node */
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeOrphanAudio } from "@main/services/orphan-audio";

const uuid = "01234567-89ab-4def-8123-456789abcdef";
const day = 24 * 60 * 60 * 1000;
let directory: string;

async function file(name: string, ageMs: number) {
  await writeFile(join(directory, name), "audio");
  const time = new Date(Date.now() - ageMs);
  await utimes(join(directory, name), time, time);
}

afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("removeOrphanAudio", () => {
  it("removes only old files with an exact temporary name", async () => {
    directory = await mkdtemp(join(tmpdir(), "meluli-orphan-audio-"));
    const orphans = ["recording-1730000000000.wav", `import-${uuid}.wav`, `youtube-${uuid}.wav`];
    const kept = ["recording-note.wav", "my-recording-1730000000000.wav", "recording-1730000000000.wav.bak",
      "import-1.wav", "youtube-episode.wav", "history.sqlite"];
    for (const name of [...orphans, ...kept]) await file(name, day);
    await mkdir(join(directory, "archive"));
    await writeFile(join(directory, "archive", orphans[0]!), "audio");
    await removeOrphanAudio(directory, Date.now(), directory);
    expect((await readdir(directory)).sort()).toEqual([...kept, "archive"].sort());
    expect(await readdir(join(directory, "archive"))).toEqual([orphans[0]]);
  });

  it("leaves recent audio to the instance that may still own it", async () => {
    directory = await mkdtemp(join(tmpdir(), "meluli-orphan-audio-"));
    await file("recording-1730000000000.wav", 60 * 1000);
    await removeOrphanAudio(directory, Date.now(), directory);
    expect(await readdir(directory)).toEqual(["recording-1730000000000.wav"]);
  });

  it("removes link-import folders a crash left a day ago, and nothing else in the temporary folder", async () => {
    directory = await mkdtemp(join(tmpdir(), "meluli-orphan-downloads-"));
    const root = join(directory, "tmp");
    const outside = join(directory, "outside");
    await mkdir(root); await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "mine");
    const age = async (path: string, ageMs: number) => { const time = new Date(Date.now() - ageMs); await utimes(path, time, time); };
    const folder = async (name: string, ageMs: number, fileAgeMs = ageMs, mode = 0o700) => {
      await mkdir(join(root, name), { mode });
      await writeFile(join(root, name, "audio.m4a.part"), "audio");
      await age(join(root, name, "audio.m4a.part"), fileAgeMs);
      await age(join(root, name), ageMs);
    };
    await folder("ivrit-youtube-a1B2c3", 2 * day);
    await folder("ivrit-youtube-mock-Z9y8X7", 2 * day);
    await folder("ivrit-youtube-d4E5f6", 60 * 1000);
    await folder("ivrit-youtube-g7H8i9", 2 * day, 60 * 1000);
    await folder("ivrit-youtube-notes", 2 * day);
    await folder("other-a1B2c3", 2 * day);
    // Not made by mkdtemp: others can read it, so it is someone else's folder with a matching name.
    await folder("ivrit-youtube-p1Q2r3", 2 * day, 2 * day, 0o755);
    await writeFile(join(root, "ivrit-youtube-j1K2l3"), "a file, not a folder");
    await age(join(root, "ivrit-youtube-j1K2l3"), 2 * day);
    await symlink(outside, join(root, "ivrit-youtube-m4N5o6"));

    await removeOrphanAudio(join(directory, "missing"), Date.now(), root);
    expect((await readdir(root)).sort()).toEqual([
      "ivrit-youtube-d4E5f6", "ivrit-youtube-g7H8i9", "ivrit-youtube-j1K2l3", "ivrit-youtube-m4N5o6", "ivrit-youtube-notes", "ivrit-youtube-p1Q2r3", "other-a1B2c3"
    ]);
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it("ignores a missing folder", async () => {
    directory = join(tmpdir(), "meluli-orphan-audio-missing");
    await expect(removeOrphanAudio(directory, Date.now(), directory)).resolves.toBeUndefined();
  });
});
