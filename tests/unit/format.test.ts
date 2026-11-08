import { describe, expect, it } from "vitest";
import { formatDurationMs, formatTranscriptDurationMs } from "@/lib/format";

describe("formatDurationMs", () => {
  it("floors live elapsed time to whole seconds", () => {
    expect(formatDurationMs(999)).toBe("00:00");
    expect(formatDurationMs(1_999)).toBe("00:01");
    expect(formatDurationMs(61_001)).toBe("01:01");
  });
});

describe("formatTranscriptDurationMs", () => {
  it("does not render positive transcript durations as 00:00", () => {
    expect(formatTranscriptDurationMs(250)).toBe("0:01");
    expect(formatTranscriptDurationMs(999)).toBe("0:01");
    expect(formatTranscriptDurationMs(1_499)).toBe("0:01");
    expect(formatTranscriptDurationMs(1_500)).toBe("0:02");
    expect(formatTranscriptDurationMs(142_000)).toBe("2:22");
    expect(formatTranscriptDurationMs(610_000)).toBe("10:10");
  });

  it("preserves 0:00 only for empty transcript durations", () => {
    expect(formatTranscriptDurationMs(0)).toBe("0:00");
    expect(formatTranscriptDurationMs(null)).toBe("0:00");
    expect(formatTranscriptDurationMs(undefined)).toBe("0:00");
  });
});
