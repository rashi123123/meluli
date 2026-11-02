import type Database from "better-sqlite3";
import type { CallSpeaker, TranscriptListResult, TranscriptRecord, TranscriptSegment } from "@shared/types";
import type { TranscriptContent } from "../services/transcript-edit.service";

interface TranscriptRow {
  id: string;
  created_at: number;
  source_type: TranscriptRecord["sourceType"];
  text: string;
  raw_text: string | null;
  paragraphs_json: string | null;
  imported_file_name: string | null;
  source_title: string | null;
  source_url: string | null;
  possible_terms_json: string | null;
  uncertain_segments_json: string | null;
  duration_ms: number | null;
  backend: TranscriptRecord["backend"];
  model_id: string | null;
  language: string | null;
  segments_json: string | null;
  original_json: string | null;
  edited_at: number | null;
}

type OriginalContent = Pick<TranscriptRow, "text" | "paragraphs_json" | "segments_json">;

function parseJsonArray(value: string | null): string[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function parseTranscriptSegments(value: string | null): TranscriptSegment[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const segments = parsed
      .map((item) => {
        if (
          !item ||
          typeof item !== "object" ||
          typeof item.start !== "number" ||
          typeof item.end !== "number" ||
          typeof item.text !== "string"
        ) {
          return null;
        }

        return {
          start: item.start,
          end: item.end,
          text: item.text,
          ...(item.speaker === "me" || item.speaker === "others" ? { speaker: item.speaker as CallSpeaker } : {})
        } satisfies TranscriptSegment;
      })
      .filter((item): item is TranscriptSegment => item !== null);

    return segments.length > 0 ? segments : null;
  } catch {
    return null;
  }
}

function mapRow(row: TranscriptRow): TranscriptRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    sourceType: row.source_type,
    text: row.text,
    rawText: row.raw_text,
    paragraphs: parseJsonArray(row.paragraphs_json),
    importedFileName: row.imported_file_name,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
    possibleTerms: parseJsonArray(row.possible_terms_json),
    uncertainSegments: parseJsonArray(row.uncertain_segments_json),
    durationMs: row.duration_ms,
    backend: row.backend,
    modelId: row.model_id,
    language: row.language,
    segments: parseTranscriptSegments(row.segments_json),
    editedAt: row.edited_at
  };
}

function buildCursorWhere(cursor: number | null): { clause: string; params: unknown[] } {
  if (cursor === null) {
    return { clause: "", params: [] };
  }

  return {
    clause: "WHERE created_at < ?",
    params: [cursor]
  };
}

/** A long paste searches for its start, rather than failing or stalling the main process. */
const MAX_SEARCH_QUERY_CHARS = 1000;
const MAX_SEARCH_QUERY_TOKENS = 64;

function escapeFtsQuery(query: string): string {
  return query
    .trim()
    .slice(0, MAX_SEARCH_QUERY_CHARS)
    .replace(/["'\u0000]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_QUERY_TOKENS)
    .map((token) => `"${token}"`)
    .join(" ");
}

export class TranscriptRepository {
  constructor(private readonly db: Database.Database) {}

  create(record: TranscriptRecord): TranscriptRecord {
    this.db
      .prepare(
        `INSERT INTO transcripts (
          id,
          created_at,
          source_type,
          text,
          raw_text,
          paragraphs_json,
          imported_file_name,
          source_title,
          source_url,
          possible_terms_json,
          uncertain_segments_json,
          duration_ms,
          backend,
          model_id,
          language,
          segments_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.createdAt,
        record.sourceType,
        record.text,
        record.rawText ?? null,
        record.paragraphs ? JSON.stringify(record.paragraphs) : null,
        record.importedFileName ?? null,
        record.sourceTitle ?? null,
        record.sourceUrl ?? null,
        record.possibleTerms ? JSON.stringify(record.possibleTerms) : null,
        record.uncertainSegments ? JSON.stringify(record.uncertainSegments) : null,
        record.durationMs ?? null,
        record.backend ?? null,
        record.modelId ?? null,
        record.language ?? null,
        record.segments ? JSON.stringify(record.segments) : null
      );

    return record;
  }

  private getRow(id: string): TranscriptRow | undefined {
    return this.db
      .prepare<unknown[], TranscriptRow>("SELECT * FROM transcripts WHERE id = ? LIMIT 1")
      .get(id);
  }

  getById(id: string): TranscriptRecord | null {
    const row = this.getRow(id);

    return row ? mapRow(row) : null;
  }

  list(limit: number, cursor: number | null = null): TranscriptListResult {
    const { clause, params } = buildCursorWhere(cursor);
    const rows = this.db
      .prepare<unknown[], TranscriptRow>(
        `SELECT *
         FROM transcripts
         ${clause}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params, limit + 1);

    return this.pageOf(rows, limit, (operator, createdAt, count) =>
      this.db
        .prepare<unknown[], TranscriptRow>(`SELECT * FROM transcripts WHERE created_at ${operator} ? ORDER BY created_at DESC LIMIT ?`)
        .all(createdAt, count)
    );
  }

  search(query: string, limit: number, cursor: number | null = null): TranscriptListResult {
    if (!query.trim()) {
      return this.list(limit, cursor);
    }

    const match = escapeFtsQuery(query);
    if (!match) {
      return { items: [], nextCursor: null };
    }

    const cursorFilter = cursor === null ? "" : "AND t.created_at < ?";
    const params: Array<string | number> = [match];
    if (cursor !== null) {
      params.push(cursor);
    }
    params.push(limit + 1);

    const rows = this.db
      .prepare<unknown[], TranscriptRow>(
        `SELECT t.*
         FROM transcripts_fts f
         JOIN transcripts t ON t.rowid = f.rowid
         WHERE transcripts_fts MATCH ?
         ${cursorFilter}
         ORDER BY t.created_at DESC
         LIMIT ?`
      )
      .all(...params);

    return this.pageOf(rows, limit, (operator, createdAt, count) =>
      this.db
        .prepare<unknown[], TranscriptRow>(
          `SELECT t.*
           FROM transcripts_fts f
           JOIN transcripts t ON t.rowid = f.rowid
           WHERE transcripts_fts MATCH ? AND t.created_at ${operator} ?
           ORDER BY t.created_at DESC
           LIMIT ?`
        )
        .all(match, createdAt, count)
    );
  }

  /** The cursor is a strict created_at bound, so a page may only end between two timestamps. A tie at the limit comes back whole, even past the limit. */
  private pageOf(
    rows: TranscriptRow[],
    limit: number,
    read: (operator: "=" | "<", createdAt: number, count: number) => TranscriptRow[]
  ): TranscriptListResult {
    const last = rows[limit - 1];
    const next = rows[limit];
    if (!last || !next) {
      return { items: rows.map(mapRow), nextCursor: null };
    }

    if (next.created_at !== last.created_at) {
      return { items: rows.slice(0, limit).map(mapRow), nextCursor: last.created_at };
    }

    const newer = rows.filter((row) => row.created_at > last.created_at);
    const hasOlder = read("<", last.created_at, 1).length > 0;
    return {
      items: [...newer, ...read("=", last.created_at, -1)].map(mapRow),
      nextCursor: hasOlder ? last.created_at : null
    };
  }

  /** The first edit keeps the transcript as it came from the model, for restoring. */
  update(id: string, content: TranscriptContent): TranscriptRecord | null {
    return this.db.transaction(() => {
      const row = this.getRow(id);
      if (!row) {
        return null;
      }

      const original: OriginalContent = { text: row.text, paragraphs_json: row.paragraphs_json, segments_json: row.segments_json };
      this.db
        .prepare("UPDATE transcripts SET text = ?, paragraphs_json = ?, segments_json = ?, edited_at = ?, original_json = ? WHERE id = ?")
        .run(
          content.text,
          content.paragraphs ? JSON.stringify(content.paragraphs) : null,
          content.segments ? JSON.stringify(content.segments) : null,
          Date.now(),
          row.original_json ?? JSON.stringify(original),
          id
        );
      return this.getById(id);
    })();
  }

  restoreOriginal(id: string): TranscriptRecord | null {
    return this.db.transaction(() => {
      const row = this.getRow(id);
      if (!row?.original_json) {
        return row ? mapRow(row) : null;
      }

      const original = JSON.parse(row.original_json) as OriginalContent;
      this.db
        .prepare("UPDATE transcripts SET text = ?, paragraphs_json = ?, segments_json = ?, edited_at = NULL, original_json = NULL WHERE id = ?")
        .run(original.text, original.paragraphs_json, original.segments_json, id);
      return this.getById(id);
    })();
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM transcripts WHERE id = ?").run(id);
    this.flushDeletes();
    return result.changes > 0;
  }

  deleteAll(): boolean {
    this.db.exec("DELETE FROM transcripts");
    this.flushDeletes();
    return true;
  }

  /**
   * secure_delete does not reach the words kept in the search index, which stay until its segments
   * merge, or the main file and write-ahead log, until those merge. FTS5's own secure-delete option
   * is left off; a delete merges the index instead.
   */
  private flushDeletes(): void {
    this.db.prepare("INSERT INTO transcripts_fts(transcripts_fts) VALUES ('optimize')").run();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
}
