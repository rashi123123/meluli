#!/usr/bin/env node
// Checks the native updater's signature rules, archive handling and bundle swap (native/host/app/Updater.swift)
// on small bundles signed here with the Apple Development identity. Nothing is downloaded or installed.
//   node scripts/meluli2/updater-check.mjs
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = join(root, ".build/updater-check");
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"], ...options }).toString();
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const identity = process.env.MELULI_SIGN_IDENTITY ?? run("security", ["find-identity", "-v", "-p", "codesigning"])
  .split("\n").map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Development/)).find(Boolean)?.[1];
if (!identity) throw new Error("No Apple Development identity to sign the test bundles with");

writeFileSync(join(work, "hello.c"), "int main(void) { return 0; }\n");
run("clang", ["-O2", "-target", "arm64-apple-macosx14.0", "hello.c", "-o", "hello"]);

const bundle = (name, { id = "dev.meluli.updater-test", version, sign = identity }) => {
  const app = join(work, `${name}.app`);
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  cpSync(join(work, "hello"), join(app, "Contents/MacOS/hello"));
  writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>hello</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>
`);
  if (sign) run("codesign", ["--force", "--sign", sign, "--options", "runtime", "--timestamp=none", app]);
  return app;
};

bundle("Current", { version: "1.0.0" });
bundle("Good", { version: "1.0.1" });
bundle("Tampered", { version: "1.0.1" });
appendFileSync(join(work, "Tampered.app/Contents/MacOS/hello"), Buffer.from([0]));
bundle("AdHoc", { version: "1.0.1", sign: "-" });
bundle("Other", { id: "dev.meluli.other", version: "1.0.1" });
bundle("Unsigned", { version: "1.0.1", sign: null });
mkdirSync(join(work, "Installed"));
cpSync(join(work, "Current.app"), join(work, "Installed/Current.app"), { recursive: true });
mkdirSync(join(work, "Installed2"));
cpSync(join(work, "Current.app"), join(work, "Installed2/Current.app"), { recursive: true });

const zip = (name, apps) => {
  const staging = join(work, `zip-${name}`);
  mkdirSync(staging);
  for (const app of apps) run("ditto", [join(work, `${app}.app`), join(staging, `${app}.app`)]);
  run("ditto", ["-c", "-k", staging, join(work, `${name}.zip`)]);
};
zip("good", ["Good"]);
zip("two", ["Good", "Other"]);
zip("tampered", ["Tampered"]);

run("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macosx14.0", "-module-cache-path", join(root, ".build/native-host/cache"),
  join(root, "native/host/app/Updater.swift"), join(root, "native/host/HostNames.swift"), join(root, "native/host/tests/updater-check.swift"), "-o", join(work, "updater-check")]);
const results = JSON.parse(run(join(work, "updater-check"), [work]));
const refused = (value) => typeof value === "string" && value.startsWith("refused");
const swap = results.swap ?? {};
const tampered = results.swapTampered ?? {};
const pass = results.good === "accepted" && ["wrongVersion", "tampered", "adHoc", "otherIdentifier", "unsigned", "unpackTwo", "unpackTampered"].every((key) => refused(results[key]))
  && results.unpackGood === "Good.app" && swap.versionWhileWaiting === "1.0.0" && swap.versionAfter === "1.0.1" && swap.exit === 0
  && JSON.stringify(swap.folderAfter) === JSON.stringify(["Current.app"]) && swap.updateFolderRemoved === true
  && tampered.versionAfter === "1.0.0" && tampered.exit === 2 && JSON.stringify(tampered.folderAfter) === JSON.stringify(["Current.app"])
  && results.hosts["https://github.com/a"] === true && Object.entries(results.hosts).filter(([url]) => url !== "https://github.com/a").every(([, ok]) => ok === false);
console.log(JSON.stringify({ ...results, pass }, null, 2));
process.exit(pass ? 0 : 1);
