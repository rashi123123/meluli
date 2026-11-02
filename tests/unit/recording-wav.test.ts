/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { encodeWavFromRecordingPayload, normalizeRecordingPcm } from "@main/services/recording-wav";

const samples = [0, 0.5, -0.5];

describe("recording audio to WAV", () => {
  it.each([
    ["a Float32Array", new Float32Array(samples)],
    ["an ArrayBuffer", new Float32Array(samples).buffer],
    ["a plain array", samples]
  ])("reads %s", (_name, pcm) => {
    expect([...normalizeRecordingPcm(pcm)]).toEqual(samples);
  });

  it("writes 16-bit PCM behind a WAV header in the encoder worker", async () => {
    const wav = await encodeWavFromRecordingPayload({ pcm: new Float32Array(samples), sampleRate: 16_000, durationMs: 1 } as never, new AbortController().signal);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(wav.readUInt32LE(24)).toBe(16_000);
  });
});
