/* @vitest-environment node */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const builderConfig = readFileSync(join(root, "electron-builder.yml"), "utf8");
const pinned = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies.electron;

describe("electron framework digest", () => {
  it("names the Electron version in package.json", () => {
    expect(builderConfig).toContain(`electron-v${pinned}-darwin-arm64.zip:`);
  });

  it("matches the installed package when it is the pinned version", () => {
    const packagePath = join(root, "node_modules/electron/package.json");
    if (!existsSync(packagePath)) return;
    const installed = (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }).version;
    if (installed !== pinned) return;
    const checksums = JSON.parse(readFileSync(join(root, "node_modules/electron/checksums.json"), "utf8")) as Record<string, string>;
    expect(builderConfig).toContain(`electron-v${pinned}-darwin-arm64.zip: ${checksums[`electron-v${pinned}-darwin-arm64.zip`]}`);
  });
});
