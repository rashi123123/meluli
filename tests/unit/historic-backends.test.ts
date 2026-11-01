/* @vitest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";
import { buildTranscriptSrt } from "@main/services/subtitle-export.service";
import { applyTranscriptEdit } from "@main/services/transcript-edit.service";
import { transcriptRecordSchema } from "@shared/schemas";
import type { TranscriptRecord } from "@shared/types";

// History outlives the engines that wrote it, so these values stay readable
// even though the app only produces "whispercpp" now.
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
const openRepository = () => {
  const dir = mkdtempSync(join(tmpdir(), "ivrit-menu-bar-test-"));
  tempDirs.push(dir);
  return createAppDatabase(dir).transcriptRepository;
};

const historic = (backend: TranscriptRecord["backend"]): TranscriptRecord => ({
  id: "historic", createdAt: 1, sourceType: "microphone", backend, modelId: "older-model",
  text: "שלום עולם שוב", rawText: "שלום עולם שוב", paragraphs: ["שלום עולם שוב"],
  segments: [{ start: 0.2, end: 0.5, text: "שלום" }, { start: 0.55, end: 1.2, text: "עולם" }, { start: 3, end: 3.4, text: "שוב" }]
});
const perSegment = "1\n00:00:00,200 --> 00:00:00,500\nשלום\n\n2\n00:00:00,550 --> 00:00:01,200\nעולם\n\n3\n00:00:03,000 --> 00:00:03,400\nשוב";
const groupedWords = "1\n00:00:00,200 --> 00:00:01,200\nשלום עולם\n\n2\n00:00:03,000 --> 00:00:03,400\nשוב";

describe.each([
  ["ct2", perSegment],
  ["nemo", groupedWords],
  [null, perSegment]
] as const)("transcript saved with backend %s", (backend, srt) => {
  it("loads, validates and stays searchable", () => {
    const repository = openRepository();
    repository.create(historic(backend));
    const loaded = repository.getById("historic");
    expect(loaded?.backend).toBe(backend);
    expect(transcriptRecordSchema.parse(loaded).backend).toBe(backend);
    expect(repository.list(10).items.map(item => item.backend)).toEqual([backend]);
    expect(repository.search("עולם", 10).items.map(item => item.id)).toEqual(["historic"]);
  });

  it("keeps its subtitle export", () => {
    const repository = openRepository();
    repository.create(historic(backend));
    expect(buildTranscriptSrt(repository.getById("historic")!)).toBe(srt);
  });

  it("can be edited and restored without losing its backend", () => {
    const repository = openRepository();
    repository.create(historic(backend));
    const original = repository.getById("historic")!;
    const cueTexts = srt === groupedWords ? ["שלום עולם גדול", "שוב"] : ["שלום", "עולם גדול", "שוב"];
    const edited = repository.update("historic", applyTranscriptEdit(original, { cueTexts }, { removeFillerWords: false }));
    expect(edited?.backend).toBe(backend);
    expect(edited?.text).toContain("גדול");
    expect(buildTranscriptSrt(edited!)).toContain("גדול");
    const restored = repository.restoreOriginal("historic");
    expect(restored?.backend).toBe(backend);
    expect(restored?.text).toBe(original.text);
    expect(restored?.segments).toEqual(original.segments);
  });
});
