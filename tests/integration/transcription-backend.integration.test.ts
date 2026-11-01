/* @vitest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production runtime packaging", () => {
  it("includes the selected native worker and excludes experimental engines and models", () => {
    const config = readFileSync("electron-builder.yml", "utf8");
    expect(config).toContain("from: resources/bin/whispercpp");
    expect(config).toContain("meluli-clipboard");
    expect(config).not.toContain("from: resources/bin/nemo");
    expect(config).not.toContain("resources/models");
    expect(config).not.toContain("mila-asr-worker");
    expect(config).toContain("target: dmg");
    expect(config).toContain("target: zip");
  });
});
