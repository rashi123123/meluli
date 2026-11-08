/* @vitest-environment node */
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingAudioStore } from "@main/services/recording-audio-store";

const ID = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const DAY = 24 * 60 * 60_000;
const second = (value = 0.25) => new Float32Array(16_000).fill(value);

describe("RecordingAudioStore", () => {
  let dir: string;
  let root: string;
  let now: number;
  let onChange: ReturnType<typeof vi.fn<() => void>>;
  const store = (pid = 4242, isAlive = (_pid: number) => false) =>
    new RecordingAudioStore(root, { now: () => now, pid, isAlive, onChange });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "meluli-recordings-"));
    root = join(dir, "recordings");
    now = 1_800_000_000_000;
    onChange = vi.fn<() => void>();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function finishedWav(name = "recording.wav"): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, Buffer.alloc(100));
    return path;
  }

  it("writes the recording as it arrives and keeps it as failed", async () => {
    const recordings = store();
    await recordings.append(ID, 0, 16_000, second());
    await recordings.append(ID, 1, 16_000, second(-2));
    expect((await stat(join(root, `${ID}.partial.wav`))).size).toBe(44 + 64_000);
    expect(await recordings.list()).toEqual([]);

    expect(await recordings.keepSpool(ID)).toBe(true);
    const wav = await readFile(join(root, `${ID}.wav`));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(64_000);
    expect(wav.readInt16LE(44)).toBe(Math.round(0.25 * 0x7fff));
    expect(wav.readInt16LE(44 + 32_000)).toBe(-0x7fff);
    expect(await recordings.list()).toEqual([{ id: ID, createdAt: now, durationMs: 2000, status: "failed", transcriptId: null }]);
    expect(onChange).toHaveBeenCalled();
  });

  it("refuses chunks out of order and the rest of that recording", async () => {
    const recordings = store();
    await expect(recordings.append(ID, 1, 16_000, second())).rejects.toThrow();
    await recordings.append(ID, 0, 16_000, second());
    await expect(recordings.append(ID, 2, 16_000, second())).rejects.toThrow("out of order");
    await expect(recordings.append(ID, 1, 16_000, second())).rejects.toThrow("out of order");
  });

  it("drops a recording too short to keep", async () => {
    const recordings = store();
    await recordings.append(ID, 0, 16_000, new Float32Array(1000));
    expect(await recordings.keepSpool(ID)).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("discards a spool and ignores chunks that arrive after it closed", async () => {
    const recordings = store();
    await recordings.append(ID, 0, 16_000, second());
    await recordings.discardSpool(ID);
    await recordings.append(ID, 1, 16_000, second());
    expect(await readdir(root)).toEqual([]);
  });

  it("replaces the spool with the finished WAV", async () => {
    const recordings = store();
    await recordings.append(ID, 0, 16_000, second());
    await recordings.keep(ID, await finishedWav(), { status: "kept", transcriptId: "t1", durationMs: 1000, sampleRate: 16_000 });
    expect((await readdir(root)).sort()).toEqual([`${ID}.json`, `${ID}.wav`]);
    expect(await recordings.get(ID)).toMatchObject({ status: "kept", transcriptId: "t1", durationMs: 1000 });
  });

  it("keeps the first time a retried recording was made", async () => {
    const recordings = store();
    await recordings.keep(ID, await finishedWav(), { status: "failed", transcriptId: null, durationMs: 1000, sampleRate: 16_000 });
    const createdAt = (await recordings.get(ID))!.createdAt;
    now += 60_000;
    await recordings.keep(ID, await finishedWav("again.wav"), { status: "kept", transcriptId: "t1", durationMs: 1000, sampleRate: 16_000 });
    expect((await recordings.get(ID))!.createdAt).toBe(createdAt);
  });

  it("attaches a transcript, or removes the audio when keeping is off", async () => {
    const recordings = store();
    await recordings.keep(ID, await finishedWav(), { status: "failed", transcriptId: null, durationMs: 1000, sampleRate: 16_000 });
    await recordings.attachTranscript(ID, "t1", true);
    expect(await recordings.get(ID)).toMatchObject({ status: "kept", transcriptId: "t1" });
    await recordings.attachTranscript(ID, "t1", false);
    expect(await recordings.get(ID)).toBeNull();
  });

  it("removes the recordings of a deleted transcript", async () => {
    const recordings = store();
    await recordings.keep(ID, await finishedWav(), { status: "kept", transcriptId: "t1", durationMs: 1000, sampleRate: 16_000 });
    await recordings.keep(OTHER, await finishedWav("b.wav"), { status: "kept", transcriptId: "t2", durationMs: 1000, sampleRate: 16_000 });
    await recordings.removeForTranscript("t1");
    expect((await recordings.list()).map(item => item.id)).toEqual([OTHER]);
  });

  it("ages out kept recordings and leaves failed ones", async () => {
    const recordings = store();
    await recordings.keep(ID, await finishedWav(), { status: "kept", transcriptId: "t1", durationMs: 1000, sampleRate: 16_000 });
    await recordings.keep(OTHER, await finishedWav("b.wav"), { status: "failed", transcriptId: null, durationMs: 1000, sampleRate: 16_000 });
    now += 6 * DAY;
    await recordings.sweep(true);
    expect(await recordings.list()).toHaveLength(2);
    now += 2 * DAY;
    await recordings.sweep(true);
    expect((await recordings.list()).map(item => item.id)).toEqual([OTHER]);
  });

  it("removes every kept recording when keeping is turned off", async () => {
    const recordings = store();
    await recordings.keep(ID, await finishedWav(), { status: "kept", transcriptId: "t1", durationMs: 1000, sampleRate: 16_000 });
    await recordings.keep(OTHER, await finishedWav("b.wav"), { status: "failed", transcriptId: null, durationMs: 1000, sampleRate: 16_000 });
    await recordings.sweep(false);
    expect((await recordings.list()).map(item => item.id)).toEqual([OTHER]);
  });

  it("recovers what a crashed run was writing", async () => {
    const crashed = store(1111);
    await crashed.append(ID, 0, 16_000, second());
    await crashed.append(ID, 1, 16_000, second());
    // The process died here: the file is still open and its header says it is empty.

    const alive = store(2222, pid => pid === 1111);
    await alive.sweep(true);
    expect(await alive.list()).toEqual([]);

    const next = store(2222, () => false);
    await next.sweep(true);
    const [recovered] = await next.list();
    expect(recovered).toMatchObject({ id: ID, status: "failed", durationMs: 2000 });
    const wav = await readFile(join(root, `${ID}.wav`));
    expect(wav.readUInt32LE(40)).toBe(64_000);
  });

  it("leaves the spool this run is writing alone", async () => {
    const recordings = store();
    await recordings.append(ID, 0, 16_000, second());
    await recordings.sweep(true);
    expect(await readdir(root)).toContain(`${ID}.partial.wav`);
  });

  it("removes old files that lost their record", async () => {
    now = Date.now();
    const recordings = store();
    await recordings.keep(ID, await finishedWav(), { status: "kept", transcriptId: "t1", durationMs: 1000, sampleRate: 16_000 });
    await rm(join(root, `${ID}.json`));
    await recordings.sweep(true);
    expect(await readdir(root)).toEqual([`${ID}.wav`]);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(join(root, `${ID}.wav`), old, old);
    now = Date.now();
    await recordings.sweep(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an id that is not a UUID", async () => {
    const recordings = store();
    await expect(recordings.append("../x", 0, 16_000, second())).rejects.toThrow("Invalid recording id");
    await expect(recordings.remove("../x")).rejects.toThrow("Invalid recording id");
    expect(await recordings.get("../x")).toBeNull();
  });

  it("clears everything", async () => {
    const recordings = store();
    await recordings.append(ID, 0, 16_000, second());
    await recordings.keep(OTHER, await finishedWav(), { status: "failed", transcriptId: null, durationMs: 1000, sampleRate: 16_000 });
    await recordings.clear();
    expect(await recordings.list()).toEqual([]);
    await expect(stat(root)).rejects.toThrow();
  });

  it("reads a kept recording's audio for playback and nothing else", async () => {
    const recordings = store();
    expect(await recordings.readAudio(ID)).toBeNull();
    await recordings.append(ID, 0, 16_000, second());
    expect(await recordings.keepSpool(ID)).toBe(true);
    const audio = await recordings.readAudio(ID);
    expect(audio?.byteLength).toBe(44 + 32_000);
    expect(Buffer.from(audio!).toString("ascii", 0, 4)).toBe("RIFF");
    await writeFile(join(root, `${ID}.wav`), Buffer.alloc(44));
    expect(await recordings.readAudio(ID)).toBeNull();
    expect(await recordings.readAudio("../escape")).toBeNull();
  });
});
