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
