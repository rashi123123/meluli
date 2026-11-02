#!/usr/bin/env node
// Writes the static version file the app polls. Usage: write-update-feed.mjs <zip-url> [output] [notes]
import { readFileSync, writeFileSync } from "node:fs";

const [zipUrl, output = "release/releases.json", notes = ""] = process.argv.slice(2);
const { version, repository } = JSON.parse(readFileSync("package.json", "utf8"));
const repositoryUrl = repository.url.replace(/\.git$/u, "");
// src/main/services/update-feed.ts refuses any other address, so a typo here would strand every copy.
const expected = `${repositoryUrl}/releases/download/v${version}/Meluli-${version}-arm64.zip`;
if (zipUrl !== expected) {
  console.error(`Usage: write-update-feed.mjs ${expected} [output] [notes]`);
  process.exit(1);
}

const release = { version, pub_date: new Date().toISOString(), notes, name: version, url: zipUrl };
writeFileSync(output, `${JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: release }] }, null, 2)}\n`);
console.log(`${output}: ${version}`);
