#!/usr/bin/env node
// Writes the static version file the app polls. Usage: write-update-feed.mjs <zip-url> [output] [notes]
import { readFileSync, writeFileSync } from "node:fs";

const [zipUrl, output = "release/releases.json", notes = ""] = process.argv.slice(2);
if (!/^https:\/\//u.test(zipUrl ?? "")) {
  console.error("Usage: write-update-feed.mjs <https zip url> [output] [notes]");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const release = { version, pub_date: new Date().toISOString(), notes, name: version, url: zipUrl };
writeFileSync(output, `${JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: release }] }, null, 2)}\n`);
console.log(`${output}: ${version}`);
