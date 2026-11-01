import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { buildAfconvertArgs, normalizeExtensiblePcmWav } from "@main/services/audio-converter.service";

describe("buildAfconvertArgs", () => {
  it("creates the expected macOS conversion command", () => {
    expect(buildAfconvertArgs("/tmp/input.m4a", "/tmp/output.wav")).toEqual([
      "-f",
      "WAVE",
      "-d",
      "LEI16@16000",
      "-c",
      "1",
      "/tmp/input.m4a",
      "/tmp/output.wav"
    ]);
  });
});

describe("normalizeExtensiblePcmWav", () => {
  const header = (tag: number, subformat: number) => {
    const bytes = Buffer.alloc(64);
    bytes.write("RIFF", 0, "latin1"); bytes.write("WAVE", 8, "latin1"); bytes.write("fmt ", 12, "latin1");
    bytes.writeUInt32LE(40, 16); bytes.writeUInt16LE(tag, 20); bytes.writeUInt16LE(subformat, 44);
    return bytes;
  };
  const normalized = (bytes: Buffer) => {
    const folder = mkdtempSync(join(tmpdir(), "meluli-wav-"));
    const path = join(folder, "audio.wav");
    writeFileSync(path, bytes);
    return normalizeExtensiblePcmWav(path).then(() => readFileSync(path)).finally(() => rmSync(folder, { recursive: true, force: true }));
  };

  it("marks extensible PCM as plain PCM and leaves the rest of the file alone", async () => {
    const bytes = header(0xfffe, 1);
    const result = await normalized(bytes);
    expect(result.readUInt16LE(20)).toBe(1);
    expect(result.subarray(22)).toEqual(bytes.subarray(22));
  });

  it("leaves plain PCM and extensible non-PCM untouched", async () => {
    expect(await normalized(header(1, 0))).toEqual(header(1, 0));
    expect(await normalized(header(0xfffe, 3))).toEqual(header(0xfffe, 3));
  });
});
