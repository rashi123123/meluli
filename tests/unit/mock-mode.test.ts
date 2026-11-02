/* @vitest-environment node */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isMockMode } from "@main/config/mock-mode";

const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
});

describe("mock mode", () => {
  it("is on for either variable, and only for the value 1", () => {
    expect(isMockMode({ IVRIT_E2E_MOCK: "1" })).toBe(true);
    expect(isMockMode({ IVRIT_USE_MOCK_SERVICES: "1" })).toBe(true);
    expect(isMockMode({ IVRIT_E2E_MOCK: "0", IVRIT_USE_MOCK_SERVICES: "true" })).toBe(false);
    expect(isMockMode({})).toBe(false);
  });

  it("reads the environment at each call, so the packaged app's delete takes effect", () => {
    vi.stubEnv("IVRIT_E2E_MOCK", "1");
    expect(isMockMode()).toBe(true);
    vi.stubEnv("IVRIT_E2E_MOCK", "");
    vi.stubEnv("IVRIT_USE_MOCK_SERVICES", "");
    expect(isMockMode()).toBe(false);
    vi.unstubAllEnvs();
  });

  it("is the only reader of the pair, apart from the shortcut guard that also needs an isolated profile", () => {
    const readers = sources("src/main").filter((path) => readFileSync(path, "utf8").includes("IVRIT_USE_MOCK_SERVICES ===")
      || readFileSync(path, "utf8").includes("IVRIT_USE_MOCK_SERVICES !=="));
    expect(readers).toEqual([join("src/main/config/mock-mode.ts")]);
  });
});
