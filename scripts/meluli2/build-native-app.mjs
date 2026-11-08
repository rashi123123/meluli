#!/usr/bin/env node
// Builds the native Meluli app (D20): the Swift host, the main-process bundle for JavaScriptCore,
// the renderer preload for WebKit, the React UI, and the helpers, laid out as electron-builder
// lays out the Electron app, then signed.
//
//   node scripts/meluli2/build-native-app.mjs [--out dir] [--name "Meluli Native Test"]
//        [--bundle-id dev.meluli.native-app] [--profile dir] [--skip-renderer] [--minify]
//        [--identity <sha1 | "-">] [--release]
//
// A development build (the default) has its own bundle identifier, profile and keychain item, so it
// never opens the person's real history, settings or saved keys. --release keeps the app's own
// identity (io.github.rashi123123.meluli) and is for the release pipeline only.
import { execFileSync } from "node:child_process";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { bundle, SAFARI_TARGET } from "./bundle-native-host.mjs";
import { appHostSources } from "./native-host-sources.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));
const esbuild = require(join(root, "node_modules/.pnpm/node_modules/esbuild"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const release = flag("--release");
const name = option("--name", release ? "Meluli" : "Meluli Native Test");
const bundleId = option("--bundle-id", release ? "io.github.rashi123123.meluli" : "dev.meluli.native-app");
// A development build keeps its data in a profile of its own, never the real IvritMenuBar folder.
const profile = option("--profile", release ? null : process.env.MELULI_NATIVE_PROFILE ?? join(root, ".build/native-profile"));
const outDir = resolve(option("--out", join(root, ".build/native-app")));
const minify = flag("--minify") || release;
// The Electron build's minimum: an update to this app reaches every Mac that ran it.
const MINIMUM_SYSTEM = "13.3";
const app = join(outDir, `${name}.app`);
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
const appOut = join(resources, "app/out");
const step = (text) => console.log(`• ${text}`);
const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });

if (release && option("--profile", null)) throw new Error("A release build has no development profile");

// 1. The React UI (electron-vite builds out/renderer; the main and preload it builds are Electron's).
if (!flag("--skip-renderer") || !existsSync(join(root, "out/renderer/index.html"))) {
  step("renderer");
  run("swift", ["-module-cache-path", ".build/swift-cache", "scripts/export-sf-symbols.swift"]);
  run(process.execPath, [join(root, "node_modules/electron-vite/bin/electron-vite.js"), "build"],
    { env: { ...process.env, MELULI_RENDERER_TARGET: SAFARI_TARGET, MELULI_RENDERER_MINIFY: minify ? "1" : "0",
      MELULI_OFFICIAL_BUILD: release ? process.env.MELULI_OFFICIAL_BUILD ?? "0" : "0" } });
}

// 2. Helpers the main process starts. The ASR worker is built separately (pnpm build:asr-worker).
const helpers = ["meluli-clipboard", "meluli-insertion", "meluli-holdkey", "meluli-callaudio"];
if (!helpers.every((helper) => existsSync(join(root, "resources/bin", helper))) || flag("--helpers")) {
  step("helpers");
  run("bash", ["scripts/build-native-helpers.sh"]);
}
const worker = join(root, "resources/bin/whispercpp/meluli-asr-worker");
if (!existsSync(worker)) throw new Error(`Missing ${relative(root, worker)}: run pnpm build:asr-worker first`);

rmSync(app, { recursive: true, force: true });
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(appOut, { recursive: true });

// 3. The main process for JavaScriptCore.
step("main bundle");
await bundle(join(root, "src/main/index.ts"), join(appOut, "main/index.js"), {
  minify,
  define: { __MELULI_OFFICIAL_BUILD__: JSON.stringify(release && process.env.MELULI_OFFICIAL_BUILD === "1") }
});

// 4. The preload for WebKit: src/preload over the renderer side of the bridge.
step("preload bundle");
await esbuild.build({
  entryPoints: [join(root, "src/preload/index.ts")],
  outfile: join(appOut, "preload/index.cjs"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: SAFARI_TARGET,
  tsconfig: join(root, "tsconfig.node.json"),
  alias: { "@shared": join(root, "src/shared") },
  plugins: [{
    name: "renderer-electron",
    setup(build) { build.onResolve({ filter: /^electron$/ }, () => ({ path: join(root, "src/native-host/renderer/electron.ts") })); }
  }],
  minify,
  legalComments: "none",
  logLevel: "warning"
});

// 5. The UI, without source maps in a release.
step("renderer files");
cpSync(join(root, "out/renderer"), join(appOut, "renderer"), { recursive: true, filter: (path) => !(minify && path.endsWith(".map")) });

// 6. Resources, as electron-builder.yml places them.
step("resources");
const copy = (from, to, filter) => cpSync(join(root, from), join(resources, to), { recursive: true, ...(filter ? { filter } : {}) });
mkdirSync(join(resources, "bin/whispercpp"), { recursive: true });
cpSync(worker, join(resources, "bin/whispercpp/meluli-asr-worker"));
for (const helper of helpers) cpSync(join(root, "resources/bin", helper), join(resources, "bin", helper));
// The streaming engine, the "fast and light" choice in settings (src/main/config/asr-engine.ts).
// A release must carry it; a test build carries it when it has been built.
const streamWorker = join(root, "resources/bin/sherpa-onnx/meluli-asr-worker");
if (release && !existsSync(streamWorker)) throw new Error("Build the streaming worker first: node scripts/build-stream-worker.mjs");
if (existsSync(streamWorker)) {
  mkdirSync(join(resources, "bin/sherpa-onnx"), { recursive: true });
  cpSync(streamWorker, join(resources, "bin/sherpa-onnx/meluli-asr-worker"));
}
// Link import's downloader stays out of a public package (check-release-output.py, FORBIDDEN_RESOURCE).
if (release) console.log("  release: leaving out resources/bin/youtube");
else if (existsSync(join(root, "resources/bin/youtube"))) copy("resources/bin/youtube", "bin/youtube");
else console.warn("  resources/bin/youtube is missing: YouTube import will report that its helper is not installed");
const excludedLicenses = ["nemo", "nemo-runtime.json", "yt-dlp-LICENSE", "yt-dlp-THIRD_PARTY_LICENSES.txt"];
copy("resources/licenses", "licenses", (path) => !excludedLicenses.some((item) => relative(join(root, "resources/licenses"), path).split("/")[0] === item));
copy("resources/icons/Assets.car", "Assets.car");
copy("resources/icons/Meluli.icns", "Meluli.icns");
copy("LICENSE", "LICENSE");
copy("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md");
mkdirSync(join(resources, "icons"), { recursive: true });
for (const file of readdirSync(join(root, "resources/icons"))) {
  if (file === "meluli-dock.png" || /^tray-(idle|paused|ready|processing\d)Template(@2x)?\.png$/.test(file)) cpSync(join(root, "resources/icons", file), join(resources, "icons", file));
}

// 7. The host.
step("host");
const sources = appHostSources(root);
mkdirSync(join(root, ".build/native-host/cache"), { recursive: true });
run("xcrun", ["swiftc", "-O", "-target", `arm64-apple-macosx${MINIMUM_SYSTEM}`, "-module-cache-path", join(root, ".build/native-host/cache"), "-lsqlite3",
  ...sources, "-o", join(contents, "MacOS/Meluli")]);

// 8. Info.plist. A development build names its own profile and keychain item (main.swift, HostSafeStorage).
step("Info.plist");
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const entries = {
  CFBundleIdentifier: bundleId,
  CFBundleName: name,
  CFBundleDisplayName: name,
  CFBundleExecutable: "Meluli",
  CFBundlePackageType: "APPL",
  CFBundleShortVersionString: pkg.version,
  CFBundleVersion: pkg.version,
  CFBundleIconFile: "Meluli.icns",
  CFBundleIconName: "Meluli",
  CFBundleDevelopmentRegion: "he",
  LSApplicationCategoryType: "public.app-category.productivity",
  LSMinimumSystemVersion: MINIMUM_SYSTEM,
  NSPrincipalClass: "NSApplication",
  NSHighResolutionCapable: true,
  NSSupportsAutomaticGraphicsSwitching: true,
  NSHumanReadableCopyright: "Copyright © 2026 Jonathan Rashi and Meluli contributors",
  NSMicrophoneUsageDescription: "מלולי משתמשת במיקרופון כדי לתמלל דיבור בעברית מקומית במחשב.",
  NSAudioCaptureUsageDescription: "מלולי מקליטה את שמע השיחה רק כשביקשת, כדי לתמלל אותה מקומית במחשב.",
  NSAppleEventsUsageDescription: "מלולי מפעילה את יישום היעד כדי להדביק את התמלול שביקשת.",
  ...(release ? {} : {
    MeluliDefaultUserData: profile,
    MeluliSafeStorageService: `${name} Safe Storage`,
    MeluliSafeStorageAccount: `${name} Key`
  })
};
const plist = Object.entries(entries).map(([key, value]) =>
  `  <key>${key}</key>${typeof value === "boolean" ? (value ? "<true/>" : "<false/>") : `<string>${escape(value)}</string>`}`).join("\n");
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plist}
</dict>
</plist>
`);
writeFileSync(join(contents, "PkgInfo"), "APPL????");

// 9. Signing: every Mach-O inside first, then the app, with the hardened runtime.
step("signing");
// A release is signed only with Developer ID (package-release.sh passes APPLE_SIGNING_IDENTITY) and a
// secure timestamp, which notarization requires; a development build takes Apple Development or ad hoc.
const identity = release
  ? option("--identity", process.env.APPLE_SIGNING_IDENTITY ? `Developer ID Application: ${process.env.APPLE_SIGNING_IDENTITY}` : null)
  : option("--identity", process.env.MELULI_SIGN_IDENTITY
    ?? execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
      .split("\n").map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Development/)).find(Boolean)?.[1] ?? "-");
if (release && !identity?.startsWith("Developer ID Application: ")) throw new Error("A release is signed with Developer ID only: set APPLE_SIGNING_IDENTITY");
const timestamp = release ? "--timestamp" : "--timestamp=none";
const entitlements = join(root, "build/entitlements.release.plist");
const machO = (path) => {
  const header = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
  return [0xcffaedfe, 0xcafebabe, 0xfeedfacf].includes(header.readUInt32BE(0));
};
const nested = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile() && stat.size > 4 && machO(path)) nested.push(path);
  }
};
walk(join(resources, "bin"));
const sign = (path) => run("codesign", ["--force", "--sign", identity, timestamp, "--options", "runtime", "--entitlements", entitlements, path],
  { stdio: ["ignore", "ignore", "inherit"] });
// Deepest first, so a framework's own binaries are signed before the framework.
for (const path of nested.sort((a, b) => b.split("/").length - a.split("/").length)) sign(path);
sign(app);
run("codesign", ["--verify", "--strict", "--deep", app]);
console.log(app);
