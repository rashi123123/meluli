/* @vitest-environment node */
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentalDictationService, experimentalDictationRoot } from "@main/services/experimental-dictation.service";
import type { NormalizedTranscriptionResult } from "@main/services/transcription.service";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "meluli-stream-")); directories.push(path); return path; }
function result(text = "שלום dashboard"): NormalizedTranscriptionResult {
  return { text, segments: [{ start: 0, end: 1, text }], language: "he", backend: "whispercpp", modelId: "test" };
}

describe("research-only dictation", () => {
  it("overlaps decoding with archive verification but withholds the result until both complete", async () => {
    const path = await root(), decode = vi.fn(async () => result()), preview = vi.fn();
    const service = new ExperimentalDictationService(path, decode, preview, 1000, false, true);
    const id = await service.begin(), pcm = new Float32Array(320);
    await service.append(id, 0, pcm);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const internals = service as unknown as { persistRecovery(directory: string, pcm: Float32Array): Promise<void> };
    const original = internals.persistRecovery.bind(service);
    vi.spyOn(internals, "persistRecovery").mockImplementation(async (...args) => { await gate; await original(...args); });
    let completed = false;
    const finishing = service.finish(pcm, 16000).then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(completed).toBe(false); expect(preview).not.toHaveBeenCalled();
    release(); expect((await finishing).text).toBe("שלום dashboard");
    expect(preview).toHaveBeenCalledOnce();
    expect(await readFile(join(path, id, "original.f32le"))).toEqual(Buffer.from(pcm.buffer));
    expect(await readFile(join(path, id, "recovery-full.f32le"))).toEqual(Buffer.from(pcm.buffer));
  });

  it("rejects an overlapping integrity mismatch without publishing the decoded text", async () => {
    const path = await root(), preview = vi.fn(), decode = vi.fn(async () => result());
    const service = new ExperimentalDictationService(path, decode, preview, 1000, false, true);
    const id = await service.begin(); await service.append(id, 0, new Float32Array([.1, .2]));
    await expect(service.finish(new Float32Array([.3, .4]),16000)).rejects.toThrow(/integrity/);
    expect(preview).not.toHaveBeenCalled(); expect(service.active).toBe(false);
    expect((await readFile(join(path,id,"original.f32le"))).byteLength).toBe(8);
    expect((await readFile(join(path,id,"recovery-full.f32le"))).byteLength).toBe(8);
  });

  it("drains an overlapping decode after archive failure and never publishes it", async () => {
    const path = await root(), preview = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const decode = vi.fn(async () => { await gate; return result(); });
    const service = new ExperimentalDictationService(path, decode, preview, 1000, false, true);
    const id = await service.begin(), pcm = new Float32Array([.1, .2]);
    await service.append(id, 0, pcm); await mkdir(join(path,id,"recovery-full.f32le"));
    let settled = false;
    const finishing = service.finish(pcm,16000).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(settled).toBe(false); expect(service.active).toBe(true);
    release(); expect(await finishing).toBeInstanceOf(Error);
    expect(preview).not.toHaveBeenCalled(); expect(service.active).toBe(false);
    expect(service.pendingRecoverySamples).toBe(pcm.length);
  });

  it("cancels overlapping finalization without exposing the final transcript", async () => {
    const path = await root(), preview = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const decode = vi.fn(async () => { await gate; return result(); });
    const service = new ExperimentalDictationService(path, decode, preview, 1000, false, true);
    const id = await service.begin(), pcm = new Float32Array([.1, .2]); await service.append(id,0,pcm);
    const finishing = service.finish(pcm,16000);
    const rejected = expect(finishing).rejects.toThrow();
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    await service.cancel(); release(); await rejected;
    expect(preview).not.toHaveBeenCalled(); expect(service.active).toBe(false);
    expect(await readFile(join(path,id,"original.f32le"))).toEqual(Buffer.from(pcm.buffer));
    expect(await readFile(join(path,id,"recovery-full.f32le"))).toEqual(Buffer.from(pcm.buffer));
  });

  it("archives every chunk in offline mode, decodes once at stop, and retains canceled audio without decoding", async () => {
    const path = await root(), decode = vi.fn(async () => result());
    const service = new ExperimentalDictationService(path, decode, () => {}, 0, false);
    const id = await service.begin(), pcm = new Float32Array(32000).fill(.1);
    await service.append(id, 0, pcm);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(decode).not.toHaveBeenCalled();
    await service.finish(pcm, 16000); expect(decode).toHaveBeenCalledOnce();
    expect((await readFile(join(path, id, "original.f32le"))).equals(Buffer.from(pcm.buffer))).toBe(true);
    const canceled = await service.begin(); await service.append(canceled, 0, pcm); await service.cancel();
    expect(decode).toHaveBeenCalledOnce();
    expect((await readFile(join(path, canceled, "original.f32le"))).equals(Buffer.from(pcm.buffer))).toBe(true);
  });
  it("is off by default, never enabled in packages, requires an isolated explicit profile", () => {
    expect(experimentalDictationRoot(false, "/tmp/p", {})).toBeNull();
    expect(experimentalDictationRoot(true, "/tmp/p", { MELULI_EXPERIMENTAL_DICTATION: "1" })).toBeNull();
    expect(() => experimentalDictationRoot(false, "/tmp/p", { MELULI_EXPERIMENTAL_DICTATION: "1" })).toThrow();
  });

  it("retains exact source samples, finishes once and never stores or pastes a partial", async () => {
    const path = await root(), decode = vi.fn(async () => result()), previews = vi.fn();
    const service = new ExperimentalDictationService(path, decode, previews);
    const id = await service.begin(), pcm = Float32Array.from([.1, -.2, .3]);
    await service.append(id, 0, pcm);
    expect((await service.finish(pcm, 16000)).text).toBe("שלום dashboard");
    expect(decode).toHaveBeenCalledTimes(1);
    expect(await readFile(join(path, id, "original.f32le"))).toEqual(Buffer.from(pcm.buffer));
    await expect(service.finish(pcm, 16000)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(path, id, "session.json"), "utf8")).status).toBe("awaiting_store_and_paste");
  });

  it("rejects sequence gaps but retains the complete recovery source after failed append", async () => {
    const path = await root(), service = new ExperimentalDictationService(path, async () => result(), () => {});
    const id = await service.begin(), pcm = new Float32Array(8);
    await expect(service.append(id, 1, pcm)).rejects.toThrow(/sequence/);
    await expect(service.finish(pcm, 16000)).rejects.toThrow();
    expect((await readFile(join(path, id, "recovery-full.f32le"))).byteLength).toBe(32);
    expect(service.active).toBe(false);
  });

  it("cancel drains already accepted audio writes before closing, without decoding or deleting", async () => {
    const path = await root(), decode = vi.fn(async () => result());
    const service = new ExperimentalDictationService(path, decode, () => {});
    const id = await service.begin(), pcm = new Float32Array(32).fill(.2);
    const pending = service.append(id, 0, pcm);
    await service.cancel(); await pending;
    expect((await readFile(join(path, id, "original.f32le"))).byteLength).toBe(128);
    expect(decode).not.toHaveBeenCalled();
  });

  it("does not re-decode identical covered audio on stop", async () => {
    const path = await root(), decode = vi.fn(async () => result());
    let notified!: () => void;
    const preview = new Promise<void>(resolve => { notified = resolve; });
    const service = new ExperimentalDictationService(path, decode, () => notified(), 1);
    const id = await service.begin(), pcm = new Float32Array(24000);
    await service.append(id, 0, pcm); await preview;
    await service.finish(pcm, 16000);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("preserves originals through 100 isolated archive/decode cycles", async () => {
    const path = await root(), decode = vi.fn(async () => result());
    const service = new ExperimentalDictationService(path, decode, () => {});
    for (let i = 0; i < 100; i++) {
      const id = await service.begin(), pcm = new Float32Array(16).fill(i / 100);
      await service.append(id, 0, pcm); await service.finish(pcm, 16000);
    }
    expect(await readdir(path)).toHaveLength(100);
    expect(decode).toHaveBeenCalledTimes(100);
  }, 30_000); // 100 real fsync cycles: not a five-second performance assertion.

  it("drains accepted writes and closes cleanly when the full recovery path is unavailable", async () => {
    const path = await root(), service = new ExperimentalDictationService(path, async () => result(), () => {});
    const id = await service.begin(), pcm = new Float32Array(32).fill(.2);
    await mkdir(join(path, id, "recovery-full.f32le"));
    const accepted = service.append(id, 0, pcm);
    await expect(service.finish(pcm, 16000)).rejects.toThrow(); await accepted;
    expect(await readFile(join(path, id, "original.f32le"))).toEqual(Buffer.from(pcm.buffer));
    expect(service.active).toBe(false);
    expect(service.pendingRecoverySamples).toBe(pcm.length);
    await expect(service.begin()).rejects.toThrow();
    await rm(join(path, id, "recovery-full.f32le"), { recursive: true });
    await service.begin();
    expect(service.pendingRecoverySamples).toBe(0);
    expect(await readFile(join(path, id, "recovery-full.f32le"))).toEqual(Buffer.from(pcm.buffer));
    await service.cancel();
  });

  it("falls back to full original audio after a live decoder failure", async () => {
    const path = await root();
    const decode = vi.fn().mockRejectedValueOnce(new Error("worker failed")).mockResolvedValue(result());
    let failed!: () => void;
    const observed = new Promise<void>(resolve => { failed = resolve; });
    const service = new ExperimentalDictationService(path, decode, preview => { if (preview.error) failed(); }, 1);
    const id = await service.begin(), pcm = new Float32Array(24000);
    await service.append(id, 0, pcm); await observed;
    expect((await service.finish(pcm, 16000)).text).toBe("שלום dashboard");
    expect(decode).toHaveBeenCalledTimes(2);
    expect(await readFile(join(path, id, "original.f32le"))).toEqual(Buffer.from(pcm.buffer));
  });
});
