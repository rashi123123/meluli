/* @vitest-environment node */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "@main/db/database";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("opening the database", () => {
  it("keeps the file private and does not trust schema-defined functions", () => {
    const dir = mkdtempSync(join(tmpdir(), "meluli-db-open-"));
    dirs.push(dir);
    const database = createAppDatabase(dir);
    expect(statSync(database.paths.databasePath).mode & 0o777).toBe(0o600);
    expect(database.db?.pragma("trusted_schema", { simple: true })).toBe(0);
    database.db?.close();
  });
});
