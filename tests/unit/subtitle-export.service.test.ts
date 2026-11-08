/* @vitest-environment node */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTranscriptFileName,
  buildTranscriptMarkdown,
  buildTranscriptSrt,
  buildTranscriptVtt,
  transcriptExportFormats,
  hasTranscriptSegments,
  writeTranscriptFile
} from "@main/services/subtitle-export.service";

describe("subtitle export", () => {
  it("writes the file for its owner only, also over a file others could read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meluli-srt-"));
    const path = join(directory, "call.srt");
    try {
      await writeTranscriptFile(path, "שלום");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("שלום");

      rmSync(path);
      writeFileSync(path, "older and longer text", { mode: 0o644 });
      await writeTranscriptFile(path, "חדש");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("חדש");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });


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
      buildTranscriptFileName({
        id: "t5",
        createdAt: 1,
        sourceType: "imported_file",
        text: "שלום",
        importedFileName: "notes:demo?.wav"
      }, "srt")
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

  it("writes WebVTT with dotted times and no cue-ending text", () => {
    const vtt = buildTranscriptVtt({ id: "v", createdAt: 1, sourceType: "imported_file", text: "x",
      segments: [{ start: 1.5, end: 2, text: "a --> b" }, { start: 3, end: 4, text: "שורה\n\nשנייה" }] });
    expect(vtt).toBe("WEBVTT\n\n00:00:01.500 --> 00:00:02.000\na → b\n\n00:00:03.000 --> 00:00:04.000\nשורה\nשנייה\n");
  });

  it("keeps a blank line or an arrow in a cue from ending an SRT cue", () => {
    const srt = buildTranscriptSrt({ id: "s", createdAt: 1, sourceType: "imported_file", text: "x",
      segments: [{ start: 0, end: 1, text: "שורה ראשונה\n\nשורה שנייה" }, { start: 1, end: 2, text: "a --> b" }] });
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,000\nשורה ראשונה\nשורה שנייה\n\n2\n00:00:01,000 --> 00:00:02,000\na → b");
  });

  it("writes & and < in WebVTT cue text as entities", () => {
    const vtt = buildTranscriptVtt({ id: "v", createdAt: 1, sourceType: "imported_file", text: "x",
      segments: [{ start: 2, end: 3, text: "R&D <3 <b>x</b>" }] });
    expect(vtt).toBe("WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nR&amp;D &lt;3 &lt;b>x&lt;/b>\n");
  });

  it("offers subtitles only when the transcript has timings", () => {
    const plain = { id: "p", createdAt: 1, sourceType: "microphone" as const, text: "שלום" };
    expect(transcriptExportFormats(plain)).toEqual(["md"]);
    expect(buildTranscriptVtt(plain)).toBeNull();
    expect(transcriptExportFormats({ ...plain, segments: [{ start: 0, end: 1, text: "שלום" }] })).toEqual(["md", "vtt", "srt"]);
    expect(buildTranscriptFileName({ ...plain, importedFileName: "פגישה.wav" }, "md")).toBe("פגישה.wav.md");
  });

  it("writes Markdown with a title, a details line and the paragraphs", () => {
    const markdown = buildTranscriptMarkdown({ id: "m", createdAt: Date.UTC(2026, 10, 5, 10), sourceType: "imported_file",
      importedFileName: "ישיבה.m4a", durationMs: 125_000, text: "ראשון\n\nשני" });
    const [title, details, ...rest] = markdown.trimEnd().split("\n\n");
    expect(title).toBe("# ישיבה.m4a");
    expect(details).toMatch(/ · 02:05$/);
    expect(rest).toEqual(["ראשון", "שני"]);
  });

});
