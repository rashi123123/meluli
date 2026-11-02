/* @vitest-environment node */
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProcessLines } from "@main/services/process-lines";

const canBuild = process.platform === "darwin" && process.arch === "arm64" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

// Every start names a folder that does not exist. A helper that wrongly accepts one fails on its
// first file with "disk", before it reaches the microphone or a tap.
describe.skipIf(!canBuild)("meluli-callaudio start command", () => {
  let work: string;
  let helper: ChildProcessWithoutNullStreams;
  let events: Array<Record<string, unknown>>;

  const missing = () => join(work, "missing");
  const send = (message: object) => { helper.stdin.write(`${JSON.stringify(message)}\n`); };
  const reply = async () => {
    await expect.poll(() => events.length, { timeout: 5_000 }).toBeGreaterThan(0);
    return events.shift();
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "meluli-callaudio-"));
    await promisify(execFile)("xcrun", [
      "swiftc", "-target", "arm64-apple-macosx14.2", "-module-cache-path", join(work, "cache"),
      resolve("native/CallAudio.swift"), "-o", join(work, "helper")
    ]);
  }, 180_000);

  afterAll(() => { rmSync(work, { recursive: true, force: true }); });

  beforeEach(() => {
    events = [];
    helper = spawn(join(work, "helper"), [], { stdio: ["pipe", "pipe", "pipe"] });
    helper.stderr.resume();
    new ProcessLines(helper.stdout).on("line", (line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== "ready") events.push(event);
    });
  });

  afterEach(() => { helper.kill("SIGTERM"); });

  it.each([
    ["an empty prefix", [""]],
    ["an empty prefix among real ones", ["us.zoom.", ""]],
    ["no prefixes", []]
  ])("refuses %s", async (_name, prefixes) => {
    send({ type: "start", id: 7, directory: missing(), prefixes });
    expect(await reply()).toEqual({ type: "error", reason: "input", id: 7 });
  });

  it("refuses a start with no id", async () => {
    send({ type: "start", directory: missing(), prefixes: ["us.zoom."] });
    expect(await reply()).toEqual({ type: "error", reason: "input" });
  });

  it("names the request when a start cannot open its files", async () => {
    send({ type: "start", id: 8, directory: missing(), prefixes: ["us.zoom."] });
    expect(await reply()).toEqual({ type: "error", reason: "disk", id: 8 });
  });
});
