import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/* @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { he } from "@shared/locale";
import { AudioConverterService, buildAfconvertArgs, MAX_DECODED_SECONDS, normalizeExtensiblePcmWav, type AudioConverterOptions } from "@main/services/audio-converter.service";
import { MAX_CALL_MS } from "@main/services/calls/call.service";

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

describe("convertInputToWav limits", () => {
  const plenty = 10 * 1024 ** 3;
  let folder: string;
  let output: string;
  let started: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "meluli-convert-"));
    output = join(folder, "output.wav");
    started = join(folder, "started");
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  // Argument 8 of buildAfconvertArgs is the output path.
  const convert = (body: string, options: AudioConverterOptions = {}) => {
    const afconvertPath = join(folder, "fake-afconvert");
    writeFileSync(afconvertPath, `#!/bin/sh\n: > "${started}"\n${body}\n`, { mode: 0o755 });
    const service = new AudioConverterService({ afconvertPath, freeBytes: async () => plenty, watchIntervalMs: 10, ...options });
    return service.convertInputToWav(join(folder, "input.caf"), output);
  };
  const writeForever = 'while :; do head -c 65536 /dev/zero >> "$8"; sleep 0.01; done';

  it("returns a conversion that stays inside every limit", async () => {
    await expect(convert('printf "small wav" > "$8"', { maxWavBytes: 1024 })).resolves.toBe(output);
    expect(readFileSync(output, "utf8")).toBe("small wav");
  });

  it("stops a decoder whose output passes the cap, whatever the file declared", async () => {
    await expect(convert(writeForever, { maxWavBytes: 256 * 1024 })).rejects.toThrow(he.audioFileTooLarge);
  });

  it("refuses output that passed the cap between two checks", async () => {
    await expect(convert('head -c 4096 /dev/zero > "$8"', { maxWavBytes: 1024, watchIntervalMs: 60_000 })).rejects.toThrow(he.audioFileTooLarge);
  });

  it("does not start when the disk is already short", async () => {
    await expect(convert("exit 0", { freeBytes: async () => 1024 })).rejects.toThrow(he.audioFileTooLarge);
    expect(existsSync(started)).toBe(false);
  });

  it("stops when the disk runs short during conversion", async () => {
    const freeBytes = async () => (existsSync(started) ? 1024 : plenty);
    await expect(convert(writeForever, { freeBytes })).rejects.toThrow(he.audioFileTooLarge);
    expect(existsSync(started)).toBe(true);
  });

  it("stops a conversion that hangs past the deadline", async () => {
    await expect(convert("exec sleep 30", { deadlineMs: 50 })).rejects.toThrow(he.audioConversionFailed);
  });

  it("keeps a whole call inside the decoded limit", () => {
    expect(MAX_DECODED_SECONDS * 1000).toBeGreaterThanOrEqual(MAX_CALL_MS);
  });

  // A crafted 500-second file: its frames per packet shrinks the declared length.
  it.runIf(existsSync("/usr/bin/afconvert"))("stops the real afconvert on a CAF with forged frames per packet", async () => {
    const pcmBytes = 8000;
    const wav = Buffer.alloc(44 + pcmBytes);
    wav.write("RIFF", 0, "latin1"); wav.writeUInt32LE(36 + pcmBytes, 4); wav.write("WAVEfmt ", 8, "latin1");
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8, 24); wav.writeUInt32LE(16, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36, "latin1"); wav.writeUInt32LE(pcmBytes, 40);
    const source = join(folder, "source.wav");
    const input = join(folder, "input.caf");
    writeFileSync(source, wav);
    expect(spawnSync("/usr/bin/afconvert", ["-f", "caff", "-d", "alac@8", "-c", "1", source, input]).status).toBe(0);

    const caf = readFileSync(input);
    let position = 8;
    while (caf.toString("latin1", position, position + 4) !== "desc") position += 12 + Number(caf.readBigInt64BE(position + 4));
    expect(caf.readUInt32BE(position + 32)).toBe(4096);
    caf.writeUInt32BE(256, position + 32);
    writeFileSync(input, caf);

    const service = new AudioConverterService({ maxWavBytes: 1024 ** 2 });
    await expect(service.convertInputToWav(input, output)).rejects.toThrow(he.audioFileTooLarge);
  });
});
