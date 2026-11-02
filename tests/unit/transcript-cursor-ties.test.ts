/* @vitest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";
import type { TranscriptRecord } from "@shared/types";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "meluli-cursor-test-"));
  tempDirs.push(dir);
  return createAppDatabase(dir).transcriptRepository;
}

function transcript(id: string, createdAt: number, text = "מילה"): TranscriptRecord {
  return { id, createdAt, sourceType: "microphone", text, rawText: text, paragraphs: [text], importedFileName: null } as TranscriptRecord;
}

type Page = { items: TranscriptRecord[]; nextCursor: number | null };

function walk(read: (cursor: number | null) => Page): { ids: string[]; pages: number } {
  const ids: string[] = [];
  let cursor: number | null = null;
  for (let pages = 1; pages < 100; pages += 1) {
    const page = read(cursor);
    ids.push(...page.items.map((item) => item.id));
    if (page.nextCursor === null) return { ids, pages };
    expect(page.nextCursor).toBeLessThan(cursor ?? Number.POSITIVE_INFINITY);
    cursor = page.nextCursor;
  }
  throw new Error("cursor never ended");
}

describe("transcript paging with equal timestamps", () => {
  it.each([[20], [21], [40], [41], [45], [100]])("list reaches all %i rows sharing one millisecond", (count) => {
    const repo = repository();
    for (let index = 0; index < count; index += 1) repo.create(transcript(`same-${index}`, 1000));
    const { ids } = walk((cursor) => repo.list(20, cursor));
    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count);
  });

  it("list reaches a tie that straddles the page boundary and everything after it", () => {
    const repo = repository();
    for (let index = 0; index < 19; index += 1) repo.create(transcript(`new-${index}`, 2000 + index));
    for (let index = 0; index < 5; index += 1) repo.create(transcript(`tie-${index}`, 1500));
    for (let index = 0; index < 30; index += 1) repo.create(transcript(`old-${index}`, 1000 - index));
    const { ids } = walk((cursor) => repo.list(20, cursor));
    expect(ids).toHaveLength(54);
    expect(new Set(ids).size).toBe(54);
  });

  it("search reaches every matching row in a tie and skips rows that do not match", () => {
    const repo = repository();
    for (let index = 0; index < 45; index += 1) repo.create(transcript(`hit-${index}`, 1000, "מילה מיוחדת"));
    for (let index = 0; index < 5; index += 1) repo.create(transcript(`miss-${index}`, 1000, "משהו אחר"));
    const { ids } = walk((cursor) => repo.search("מיוחדת", 20, cursor));
    expect(ids).toHaveLength(45);
    expect(ids.every((id) => id.startsWith("hit-"))).toBe(true);
  });

  it("keeps ordinary pages at the limit and ends with no cursor", () => {
    const repo = repository();
    for (let index = 0; index < 41; index += 1) repo.create(transcript(`row-${index}`, 1000 + index));
    const first = repo.list(20, null);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe(1021);
    const { ids, pages } = walk((cursor) => repo.list(20, cursor));
    expect(ids).toHaveLength(41);
    expect(pages).toBe(3);
  });

  it("reports no next page when a tie group was the last of the history", () => {
    const repo = repository();
    for (let index = 0; index < 25; index += 1) repo.create(transcript(`same-${index}`, 1000));
    const page = repo.list(20, null);
    expect(page.nextCursor).toBeNull();
  });
});
