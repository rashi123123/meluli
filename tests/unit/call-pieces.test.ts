import { describe, expect, it } from "vitest";
import { FRAME_MS, findSpeech, frameLevel, MAX_PIECE_MS, pieceToCallMs, planPieces } from "../../src/main/services/calls/call-pieces";

function levels(ms: number, fill: (at: number) => number): Float32Array {
  return Float32Array.from({ length: Math.floor(ms / FRAME_MS) }, (_, index) => fill(index * FRAME_MS));
}

describe("frameLevel", () => {
  it("measures silence and full scale", () => {
    expect(frameLevel(new Int16Array(480))).toBe(0);
    expect(frameLevel(new Int16Array(480).fill(-32768))).toBeCloseTo(1);
  });
});

describe("findSpeech", () => {
  it("finds nothing in digital silence", () => {
    expect(findSpeech(levels(60_000, () => 0))).toEqual([]);
  });

  it("finds nothing in steady room noise", () => {
    expect(findSpeech(levels(60_000, (at) => 0.02 + (at % 90) / 90 * 0.01))).toEqual([]);
  });

  it("keeps a speaker who barely pauses", () => {
    const regions = findSpeech(levels(60_000, () => 0.2));
    expect(regions).toEqual([{ startMs: 0, endMs: 60_000 }]);
  });

  it("finds speech over room noise and pads it", () => {
    const regions = findSpeech(levels(60_000, (at) => at >= 20_000 && at < 23_000 ? 0.2 : 0.01));
    expect(regions).toEqual([{ startMs: 19_810, endMs: 23_210 }]);
  });

  it("ignores a click", () => {
    expect(findSpeech(levels(60_000, (at) => at === 30_000 ? 0.5 : 0.01))).toEqual([]);
  });

  it("joins words across a short pause", () => {
    const speaking = (at: number) => (at >= 1_000 && at < 2_000) || (at >= 2_300 && at < 3_000);
    expect(findSpeech(levels(60_000, (at) => speaking(at) ? 0.2 : 0.01))).toHaveLength(1);
  });
});

describe("planPieces", () => {
  it("keeps every piece under the limit and loses no speech", () => {
    const speaking = (at: number) => at % 20_000 < 15_000;
    const input = levels(30 * 60_000, (at) => speaking(at) ? 0.2 : 0.01);
    const pieces = planPieces(input);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.durationMs).toBeLessThanOrEqual(MAX_PIECE_MS);
    const spans = pieces.flatMap((piece) => piece.spans);
    expect(spans).toHaveLength(findSpeech(input).length);
  });

  it("splits a long speech at the quietest moment", () => {
    const input = levels(10 * 60_000, (at) => at >= 230_000 && at < 230_090 ? 0.05 : 0.2);
    const [first, second] = planPieces(input);
    expect(first!.spans[0]!.endMs).toBe(230_070);
    expect(second!.spans[0]!.startMs).toBe(230_070);
  });

  it("maps times inside a piece back to the call", () => {
    const piece = { durationMs: 2_300, spans: [
      { startMs: 10_000, endMs: 11_000, pieceMs: 0 },
      { startMs: 50_000, endMs: 51_000, pieceMs: 1_300 }
    ] };
    expect(pieceToCallMs(piece, 500)).toBe(10_500);
    expect(pieceToCallMs(piece, 1_150)).toBe(11_000);
    expect(pieceToCallMs(piece, 1_800)).toBe(50_500);
  });
});
