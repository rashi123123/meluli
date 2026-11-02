/* @vitest-environment node */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockConnectSrc } from "../../electron.vite.config";

const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const GOOD_FUSES = "01001100";
const GOOD_HTML = "<meta content=\"default-src 'self'; connect-src 'self'; img-src 'self'\">";
const GOOD_ENTITLEMENTS = [
  "com.apple.security.device.audio-input",
  "com.apple.security.automation.apple-events",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.disable-library-validation"
];

function asar(html: string): Buffer {
  const json = JSON.stringify({ files: { out: { files: { renderer: { files: {
    "index.html": { offset: "0", size: Buffer.byteLength(html) }
  } } } } } });
  const name = Buffer.from(json);
  const padded = Math.ceil(name.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(name.length, 12);
  name.copy(header, 16);
  return Buffer.concat([header, Buffer.from(html)]);
}

let root: string;
function app(options: { fuses?: string; html?: string; entitlements?: string[] } = {}): { path: string; env: NodeJS.ProcessEnv } {
  root = mkdtempSync(join(tmpdir(), "release-check-"));
  const path = join(root, "Meluli.app");
  const framework = join(path, "Contents/Frameworks/Electron Framework.framework");
  mkdirSync(framework, { recursive: true });
  mkdirSync(join(path, "Contents/Resources"), { recursive: true });
  const fuses = options.fuses ?? GOOD_FUSES;
  writeFileSync(join(framework, "Electron Framework"),
    Buffer.concat([Buffer.from(`padding${SENTINEL}`), Buffer.from([1, fuses.length]), Buffer.from(fuses)]));
  writeFileSync(join(path, "Contents/Resources/app.asar"), asar(options.html ?? GOOD_HTML));

  const bin = join(root, "bin");
  mkdirSync(bin);
  const keys = (options.entitlements ?? GOOD_ENTITLEMENTS).map((key) => `<key>${key}</key><true/>`).join("");
  writeFileSync(join(bin, "codesign"), `#!/bin/sh\ncat <<'P'\n<?xml version="1.0"?><plist version="1.0"><dict>${keys}</dict></plist>\nP\n`);
  chmodSync(join(bin, "codesign"), 0o755);
  return { path, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function check({ path, env }: { path: string; env: NodeJS.ProcessEnv }) {
  const run = spawnSync("python3", ["scripts/check-release-output.py", path], { encoding: "utf8", env });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("release check on a packaged app", () => {
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("passes the state the app ships in", () => {
    expect(check(app())).toMatchObject({ status: 0 });
  });

  it.each([
    ["run as node on", "11001100"],
    ["node options on", "01101100"],
    ["inspect on", "01011100"],
    ["asar integrity off", "01000100"],
    ["loading outside the asar on", "01001000"],
    ["a truncated wire", "0100"]
  ])("fails with %s", (_name, fuses) => {
    const result = check(app({ fuses }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("fuse_state");
  });

  it("fails when the built renderer may connect beyond itself", () => {
    const result = check(app({ html: "<meta content=\"connect-src 'self' http://localhost:*;\">" }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("built_csp");
  });

  it("fails when the app carries an entitlement it should not", () => {
    const result = check(app({ entitlements: [...GOOD_ENTITLEMENTS, "com.apple.security.get-task-allow"] }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("entitlements");
  });
});

describe("production connect-src", () => {
  it("narrows the directive", () => {
    expect(lockConnectSrc("default-src 'self'; connect-src 'self' http://localhost:* ws://[::1]:*; img-src 'self'"))
      .toBe("default-src 'self'; connect-src 'self'; img-src 'self'");
  });

  it("stops the build when there is nothing to narrow", () => {
    expect(() => lockConnectSrc("<title>no policy</title>")).toThrow(/connect-src/);
  });
});
