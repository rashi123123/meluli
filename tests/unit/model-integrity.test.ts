import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelIntegrity } from "../../src/main/services/model-integrity";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "meluli-integrity-")); directories.push(directory);
  const files = [{ path: "config.json", content: "{}" }, { path: "weights.bin", content: "valid weights" }];
  const checker = new ModelIntegrity({ id: "fixture/model", revision: "a".repeat(40), files: files.map(({ path, content }) => ({ path, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") })) });
  return { directory, files, checker };
}

describe("model integrity", () => {
  it("requires every file, not just the config or a weight filename", async () => {
    const { directory, files, checker } = await fixture();
    await writeFile(join(directory, files[0].path), files[0].content);
    expect(await checker.verify(directory)).toBe(false);
    await writeFile(join(directory, files[1].path), files[1].content);
    expect(await checker.verify(directory)).toBe(true);
  });
  it("detects same-size corruption after a successful verification", async () => {
    const { directory, files, checker } = await fixture();
    for (const file of files) await writeFile(join(directory, file.path), file.content);
    expect(await checker.verify(directory)).toBe(true);
    await writeFile(join(directory, "weights.bin"), "other weights");
    expect(await checker.verify(directory)).toBe(false);
    await writeFile(join(directory, "weights.bin"), "valid weights");
    expect(await checker.verify(directory)).toBe(true);
  });
  it("rejects symlinked weights and missing model directories", async () => {
    const { directory, files, checker } = await fixture();
    await writeFile(join(directory, "config.json"), files[0].content);
    await writeFile(join(directory, "target"), files[1].content);
    await symlink(join(directory, "target"), join(directory, "weights.bin"));
    expect(await checker.verify(directory)).toBe(false);
    expect(await checker.verify(join(directory, "missing"))).toBe(false);
  });
});

describe("model integrity record", () => {
  async function recorded() {
    const base = await fixture();
    const record = join(base.directory, "..", `${base.directory.split("/").pop()}.verified.json`);
    directories.push(record);
    for (const file of base.files) await writeFile(join(base.directory, file.path), file.content);
    return { ...base, record };
  }
  const manifestOf = (files: Array<{ path: string; content: string }>) => ({ id: "fixture/model", revision: "a".repeat(40), files: files.map(({ path, content }) => ({ path, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") })) });

  it("trusts an unchanged model on the next launch without reading it again", async () => {
    const { directory, files, record } = await recorded();
    expect(await new ModelIntegrity(manifestOf(files), record).verify(directory)).toBe(true);
    // The record holds for the manifest it was written for, and no other.
    const next = new ModelIntegrity(manifestOf(files), record);
    expect(await next.verify(directory)).toBe(true);
    const other = new ModelIntegrity(manifestOf([files[0], { path: "weights.bin", content: "other weights" }]), record);
    expect(await other.verify(directory)).toBe(false);
  });
  it("hashes again after a file is rewritten, and forgets the record when that fails", async () => {
    const { directory, files, record } = await recorded();
    expect(await new ModelIntegrity(manifestOf(files), record).verify(directory)).toBe(true);
    await writeFile(join(directory, "weights.bin"), "other weights");
    expect(await new ModelIntegrity(manifestOf(files), record).verify(directory)).toBe(false);
    await writeFile(join(directory, "weights.bin"), "valid weights");
    const { existsSync } = await import("node:fs");
    expect(existsSync(record)).toBe(false);
    expect(await new ModelIntegrity(manifestOf(files), record).verify(directory)).toBe(true);
    expect(existsSync(record)).toBe(true);
  });
  it("ignores a record for another directory or a damaged record", async () => {
    const { directory, files, record } = await recorded();
    await writeFile(record, JSON.stringify({ version: 1, manifest: "x", directory: "/elsewhere", fingerprint: "y" }));
    expect(await new ModelIntegrity(manifestOf(files), record).verify(directory)).toBe(true);
    await writeFile(record, "{not json");
    expect(await new ModelIntegrity(manifestOf(files), record).verify(directory)).toBe(true);
  });
});
