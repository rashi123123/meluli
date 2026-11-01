/* @vitest-environment node */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadVerifiedFile, modelFilePath, verifyModelFile } from "@main/services/verified-download";

const bytes = Buffer.from("a verified local model");
const manifest = { path: "weights.bin", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const url = "https://huggingface.co/example/model/resolve/abc/weights.bin";
describe("verified model downloads", () => {
  let directory: string;
  let path: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "meluli-download-")); path = join(directory, manifest.path);
    fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
  const run = (path: string, signal = new AbortController().signal) => downloadVerifiedFile(url, path, manifest, signal, () => {}, { retries: 1 });

  it("resumes an interrupted transfer and publishes only verified bytes", async () => {
    await writeFile(path + ".partial", bytes.subarray(0, 6));
    fetchMock.mockResolvedValue(new Response(bytes.subarray(6), { status: 206, headers: { "content-range": `bytes 6-${bytes.length-1}/${bytes.length}` } }));
    await run(path);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Range: "bytes=6-" });
    expect(await readFile(path)).toEqual(bytes);
    await expect(readFile(path + ".partial")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("replaces a partial transfer when the server ignores Range", async () => {
    await writeFile(path + ".partial", bytes.subarray(0, 6)); fetchMock.mockResolvedValue(new Response(bytes));
    await run(path); expect(await readFile(path)).toEqual(bytes);
  });
  it("rejects corrupted bytes without replacing an existing file", async () => {
    await writeFile(path, "old model"); fetchMock.mockResolvedValue(new Response(Buffer.alloc(bytes.length)));
    await expect(run(path)).rejects.toThrow("integrity");
    expect(await readFile(path, "utf8")).toBe("old model");
    expect(await verifyModelFile(path, manifest)).toBe(false);
  });
  it("keeps partial bytes when canceled so a later run can resume", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url, init) => {
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(bytes.subarray(0, 6));
        init.signal.addEventListener("abort", () => stream.error(init.signal.reason), { once: true });
      } }));
    });
    await expect(downloadVerifiedFile(url, path, manifest, controller.signal, received => {
      if (received === 6) controller.abort(new Error("user canceled"));
    }, { retries: 1 })).rejects.toThrow("user canceled");
    expect(await readFile(path + ".partial")).toEqual(bytes.subarray(0, 6));
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses redirects outside the trusted HTTPS model hosts", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://untrusted.example/model" } }));
    await expect(run(path)).rejects.toThrow("Untrusted"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched range before writing", async () => {
    await writeFile(path + ".partial", bytes.subarray(0, 6));
    fetchMock.mockResolvedValue(new Response(bytes.subarray(6), { status: 206, headers: { "content-range": `bytes 0-${bytes.length-1}/${bytes.length}` } }));
    await expect(run(path)).rejects.toThrow("byte range");
    expect(await readFile(path + ".partial")).toEqual(bytes.subarray(0, 6));
  });
  it("uses intact cached files without network access", async () => {
    await writeFile(path, bytes); await run(path); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not follow a partial-file symlink or allow traversal", async () => {
    const protectedFile = join(directory, "protected"); await writeFile(protectedFile, "keep");
    await symlink(protectedFile, path + ".partial"); fetchMock.mockResolvedValue(new Response(bytes));
    await expect(run(path)).rejects.toThrow(); expect(await readFile(protectedFile, "utf8")).toBe("keep");
    expect(() => modelFilePath(directory, "../protected")).toThrow();
  });
});
