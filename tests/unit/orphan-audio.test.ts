/* @vitest-environment node */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
    await removeOrphanAudio(directory);
    expect((await readdir(directory)).sort()).toEqual([...kept, "archive"].sort());
    expect(await readdir(join(directory, "archive"))).toEqual([orphans[0]]);
  });

  it("leaves recent audio to the instance that may still own it", async () => {
    directory = await mkdtemp(join(tmpdir(), "meluli-orphan-audio-"));
    await file("recording-1730000000000.wav", 60 * 1000);
    await removeOrphanAudio(directory);
    expect(await readdir(directory)).toEqual(["recording-1730000000000.wav"]);
  });

  it("ignores a missing folder", async () => {
    directory = join(tmpdir(), "meluli-orphan-audio-missing");
    await expect(removeOrphanAudio(directory)).resolves.toBeUndefined();
  });
});
