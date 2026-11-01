/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUserDataPath } from "@main/config/user-data";

describe("persistent storage identity", () => {
  it("preserves IvritMenuBar history after renaming the product", () => {
    expect(resolveUserDataPath("/app-data", {})).toBe("/app-data/IvritMenuBar");
  });
  it("isolates explicit preview profiles", () => {
    expect(resolveUserDataPath("/app-data", { MELULI_USER_DATA: "/tmp/preview" })).toBe("/tmp/preview");
  });
  it("rejects a symlink alias and descendants of the personal profile", () => {
    const root = mkdtempSync(join(tmpdir(), "meluli-profile-"));
    try {
      mkdirSync(join(root, "IvritMenuBar"));
      symlinkSync(join(root, "IvritMenuBar"), join(root, "alias"));
      for (const target of [join(root, "alias"), join(root, "alias", "nested")]) {
        expect(() => resolveUserDataPath(root, { IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: target })).toThrow();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects mock runs without an isolated profile or pointing at personal history", () => {
    expect(() => resolveUserDataPath("/app-data", { IVRIT_E2E_MOCK: "1" })).toThrow();
    expect(() => resolveUserDataPath("/app-data", { IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: "/app-data/IvritMenuBar" })).toThrow();
    expect(() => resolveUserDataPath("/app-data", { MELULI_USER_DATA: "relative" })).toThrow();
  });
});
