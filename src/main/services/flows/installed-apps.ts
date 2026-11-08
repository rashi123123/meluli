import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { FlowApp } from "@shared/flows";
import { APP_ID } from "@shared/constants";
import { minimalChildEnv } from "../child-env";

const run = promisify(execFile);

async function bundlesIn(directory: string, depth = 1): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.name.endsWith(".app")) found.push(path);
    else if (depth > 0) found.push(...await bundlesIn(path, depth - 1));
  }
  return found;
}

async function bundleId(path: string): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents", "Info.plist")], { timeout: 2_000, env: minimalChildEnv(process.env) });
    const value = stdout.trim();
    return value && value.length <= 255 ? value : null;
  } catch { return null; }
}

/** Apps the user can attach to a flow: what is installed, read from each bundle, never from the network. */
export async function listInstalledApps(): Promise<FlowApp[]> {
  const roots = ["/Applications", "/System/Applications", join(homedir(), "Applications")];
  const paths = (await Promise.all(roots.map((root) => bundlesIn(root)))).flat();
  const apps = new Map<string, FlowApp>();
  // Spotlight answers for every bundle in one call; each bundle it misses is read directly.
  let ids: (string | null)[] = [];
  try {
    const { stdout } = await run("/usr/bin/mdls", ["-name", "kMDItemCFBundleIdentifier", "-raw", ...paths], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: minimalChildEnv(process.env) });
    ids = stdout.split("\0").map((value) => (value && value !== "(null)" ? value.trim() : null));
  } catch { ids = []; }
  await Promise.all(paths.map(async (path, index) => {
    const id = (ids.length === paths.length ? ids[index] : null) ?? await bundleId(path);
    if (!id || id.startsWith(APP_ID)) return;
    apps.set(id, { bundleId: id, name: basename(path, ".app").slice(0, 120) });
  }));
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}
