/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  buildTranscriptSrt,
  buildTranscriptSrtFileName,
  hasTranscriptSegments
} from "@main/services/subtitle-export.service";

describe("subtitle export", () => {
  it("builds stable SRT output from transcript segments", () => {
    expect(
      buildTranscriptSrt({
        id: "t1",
        createdAt: 1,
        sourceType: "youtube",
        text: "שלום עולם",
        sourceTitle: "וידאו לדוגמה",
        segments: [
          { start: 0, end: 1.4, text: "שלום" },
          { start: 1.4, end: 3.05, text: "עולם" }
        ]
      })
    ).toBe(
      "1\n00:00:00,000 --> 00:00:01,400\nשלום\n\n2\n00:00:01,400 --> 00:00:03,050\nעולם"
    );
  });

  it("returns null when segment timestamps are unavailable", () => {
    expect(
      buildTranscriptSrt({
        id: "t2",
        createdAt: 1,
        sourceType: "microphone",
        text: "ללא מקטעים"
      })
    ).toBeNull();
  });

  it("detects whether a transcript can expose SRT export", () => {
    expect(
      hasTranscriptSegments({
        id: "t3",
        createdAt: 1,
        sourceType: "microphone",
        text: "שלום",
        segments: [{ start: 0, end: 1, text: "שלום" }]
      })
    ).toBe(true);

    expect(
      hasTranscriptSegments({
        id: "t4",
        createdAt: 1,
        sourceType: "microphone",
        text: "שלום"
      })
    ).toBe(false);
  });

  it("builds a safe SRT filename from transcript metadata", () => {
    expect(
      buildTranscriptSrtFileName({
        id: "t5",
        createdAt: 1,
        sourceType: "imported_file",
        text: "שלום",
        importedFileName: "notes:demo?.wav"
      })
    ).toBe("notes demo .wav.srt");
  });
  it("groups native word timestamps into readable cues without crossing long silence", () => {
    const srt = buildTranscriptSrt({ id: "native", createdAt: 1, sourceType: "microphone", backend: "nemo", text: "שלום עולם שוב",
      segments: [{ start: 0.2, end: 0.5, text: "שלום" }, { start: 0.55, end: 1.2, text: "עולם" }, { start: 3, end: 3.4, text: "שוב" }] });
    expect(srt).toBe("1\n00:00:00,200 --> 00:00:01,200\nשלום עולם\n\n2\n00:00:03,000 --> 00:00:03,400\nשוב");
  });

  it("does not export invalid numeric timestamps", () => {
    expect(buildTranscriptSrt({ id: "invalid", createdAt: 1, sourceType: "imported_file", text: "bad",
      segments: [{ start: Number.NaN, end: Infinity, text: "bad" }] })).toBeNull();
  });

});
