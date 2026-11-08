/* @vitest-environment node */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Apple's tools stand in here, with the output formats they print. A real signed bundle is only proven by the release workflow.
const TEAM = "ABCDE12345";
const VERSION = "1.2.3";
const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const FEED = "https://github.com/rashi123123/meluli/releases/latest/download/releases.json";
const ENTITLEMENTS = ["com.apple.security.device.audio-input", "com.apple.security.automation.apple-events", "com.apple.security.cs.allow-jit"];
const HELPERS = ["bin/meluli-clipboard", "bin/meluli-insertion", "bin/meluli-holdkey", "bin/meluli-callaudio", "bin/whispercpp/meluli-asr-worker", "bin/sherpa-onnx/meluli-asr-worker"];
const REQUIREMENT = `designated => identifier "io.github.rashi123123.meluli" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = ${TEAM}`;
const SIGNATURE = `Executable=/x
Identifier=io.github.rashi123123.meluli
CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded
Authority=Developer ID Application: Example (${TEAM})
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 2, 2026 at 10:00:00
TeamIdentifier=${TEAM}`;

function asar(files: Record<string, string>): Buffer {
  let offset = 0;
  const tree: { files: Record<string, unknown> } = { files: {} };
  for (const [path, body] of Object.entries(files)) {
    const parts = path.split("/");
    const name = parts.pop()!;
    let node = tree;
    for (const part of parts) node = (node.files[part] ??= { files: {} }) as typeof tree;
    node.files[name] = { offset: String(offset), size: Buffer.byteLength(body) };
    offset += Buffer.byteLength(body);
  }
  const name = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(name.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(name.length, 12);
  name.copy(header, 16);
  return Buffer.concat([header, Buffer.from(Object.values(files).join(""))]);
}

const machO = (cpu = 0x0100000c) => {
  const head = Buffer.alloc(32);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(head);
  head.writeUInt32LE(cpu, 4);
  return head;
};

function write(path: string, body: string | Buffer, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode) chmodSync(path, mode);
}

interface Options {
  signature?: string;
  requirement?: string;
  spctl?: string;
  stapled?: boolean;
  verifies?: boolean;
  library?: string;
  bundleVersion?: string;
  mainBody?: string;
  entitlements?: string[];
  skip?: string;
  extra?: string;
  cpu?: number;
  helperWithBracket?: boolean;
  asarExtra?: string;
  thirdPartyPath?: boolean;
}

let root: string;
function release(options: Options = {}) {
  root = mkdtempSync(join(tmpdir(), "release-bundle-"));
  const app = join(root, "Meluli.app");
  const version = options.bundleVersion ?? VERSION;
  write(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>io.github.rashi123123.meluli</string>
    <key>CFBundleName</key><string>Meluli</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${version}</string>
    <key>LSMinimumSystemVersion</key><string>13.3</string>
    <key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><string>x</string></dict>
    <key>NSMicrophoneUsageDescription</key><string>m</string>
    <key>NSAudioCaptureUsageDescription</key><string>a</string>
    <key>NSAppleEventsUsageDescription</key><string>e</string>
  </dict></plist>`);
  write(join(app, "Contents/MacOS/Meluli"), machO(options.cpu));
  write(join(app, "Contents/Frameworks/Electron Framework.framework/Electron Framework"),
    Buffer.concat([Buffer.from(`padding${SENTINEL}`), Buffer.from([1, 8]), Buffer.from("01001100")]));
  write(join(app, "Contents/Resources/app.asar"), asar({
    "out/main/index.js": `${options.mainBody ?? `const feed = "${FEED}";`}${options.asarExtra ?? ""}`,
    "out/renderer/index.html": "<meta content=\"connect-src 'self';\">"
  }));
  for (const helper of HELPERS) if (helper !== options.skip) write(join(app, "Contents/Resources", helper), machO());
  if (options.extra) write(join(app, "Contents/Resources", options.extra), "x");
  if (options.helperWithBracket) write(join(app, "Contents/Frameworks/Meluli Helper (Renderer).app/Contents/MacOS/Meluli Helper (Renderer)"), machO());
  if (options.thirdPartyPath) write(join(app, "Contents/Frameworks/Sample/notes.txt"), "/Users/" + "someone/electron/src");

  const bin = join(root, "tools");
  const keys = (options.entitlements ?? ENTITLEMENTS).map(key => `<key>${key}</key><true/>`).join("");
  write(join(bin, "codesign"), `#!/bin/sh
case "$*" in
  --verify*) ${options.verifies === false ? "echo invalid >&2; exit 1" : "exit 0"} ;;
  *--entitlements*) printf '%s' '<?xml version="1.0"?><plist version="1.0"><dict>${keys}</dict></plist>' ;;
  *-r-*) printf '%s\\n' '${options.requirement ?? REQUIREMENT}' ;;
  *) cat >&2 <<'S'
${options.signature ?? SIGNATURE}
S
  ;;
esac
`, 0o755);
  write(join(bin, "spctl"), `#!/bin/sh\nprintf '%s\\n' '${options.spctl ?? "accepted\nsource=Notarized Developer ID"}' >&2\n`, 0o755);
  write(join(bin, "xcrun"), `#!/bin/sh
case "$1" in
  otool) ${options.library === "@@FAIL" ? "exit 1" : `case "$3" in *\\)) exit 1 ;; esac; printf '%s:\\n\\t%s (compatibility version 1.0.0)\\n' "$3" '${options.library ?? "/usr/lib/libSystem.B.dylib"}'`} ;;
  stapler) ${options.stapled === false ? "exit 65" : "exit 0"} ;;
esac
`, 0o755);
  return { app, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function check({ app, env }: ReturnType<typeof release>) {
  const run = spawnSync("python3", ["scripts/check-release-output.py", "--release", VERSION, TEAM, app], { encoding: "utf8", env });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("release check on a trusted build", () => {
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("passes a notarized Developer ID bundle", () => {
    expect(check(release())).toMatchObject({ status: 0 });
  });

  it.each<[string, Options, string]>([
    ["an ad hoc signature", { signature: "Signature=adhoc\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed)\nTeamIdentifier=not set" }, "ad_hoc_signature"],
    ["a development certificate", { signature: SIGNATURE.replace("Developer ID Application", "Apple Development") }, "not_developer_id"],
    ["another team", { signature: SIGNATURE.replaceAll(TEAM, "ZZZZZ99999") }, "wrong_team"],
    ["no hardened runtime", { signature: SIGNATURE.replace("flags=0x10000(runtime)", "flags=0x0(none)") }, "no_hardened_runtime"],
    ["no secure timestamp", { signature: SIGNATURE.replace("Timestamp=", "Signed Time=") }, "no_secure_timestamp"],
    ["a broken seal", { verifies: false }, "bundle_signature"],
    ["a requirement from another team", { requirement: REQUIREMENT.replace(TEAM, "ZZZZZ99999") }, "designated_requirement"],
    ["a build Gatekeeper rejects", { spctl: "rejected\nsource=Unnotarized Developer ID" }, "gatekeeper"],
    ["no stapled ticket", { stapled: false }, "stapled_ticket"],
    ["a build number in CFBundleVersion", { bundleVersion: "1.2.3.456" }, "info_plist"],
    ["a build from source, with no update feed", { mainBody: "const feed = \"\";" }, "update_feed"],
    ["a library from outside the system", { library: "/opt/homebrew/lib/libomp.dylib" }, "external_library"],
    ["an Intel slice", { cpu: 0x01000007 }, "not_arm64"],
    ["a missing paste helper", { skip: "bin/meluli-insertion" }, "missing_resource"],
    ["a missing worker", { skip: "bin/whispercpp/meluli-asr-worker" }, "missing_resource"],
    ["a missing streaming worker", { skip: "bin/sherpa-onnx/meluli-asr-worker" }, "missing_resource"],
    ["the link import helper", { extra: "bin/youtube/yt-dlp" }, "forbidden_resource"],
    ["model weights", { extra: "models/ggml-ivrit-whisper-large-v3-turbo-q8_0.bin" }, "forbidden_resource"],
    ["a weakened entitlement", { entitlements: [...ENTITLEMENTS, "com.apple.security.cs.disable-library-validation"] }, "entitlements"]
  ])("fails with %s", (_name, options, label) => {
    const result = check(release(options));
    expect(result.status).toBe(1);
    expect(result.output).toContain(label);
  });

  it("accepts a quoted team identifier, and helpers whose names end in a bracket", () => {
    const requirement = REQUIREMENT.replace(`= ${TEAM}`, `= "${TEAM}"`);
    expect(check(release({ requirement, helperWithBracket: true }))).toMatchObject({ status: 0 });
  });

  it("fails when a binary cannot be read for its libraries", () => {
    const result = check(release({ library: "@@FAIL" }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("unreadable_libraries");
  });

  it("keeps scanning our own files, past the third-party ones", () => {
    const result = check(release({ asarExtra: "const path = \"/Users/" + "someone/project\";" }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("home_path");
    const clean = release({ thirdPartyPath: true });
    expect(check(clean)).toMatchObject({ status: 0 });
  });

  it("takes only a packaged app", () => {
    const run = spawnSync("python3", ["scripts/check-release-output.py", "--release", VERSION, TEAM, "/tmp/Meluli-source.zip"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("packaged app");
    root = mkdtempSync(join(tmpdir(), "release-bundle-"));
  });
});
