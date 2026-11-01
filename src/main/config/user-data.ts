import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { APP_SUPPORT_DIR_NAME } from "@shared/constants";

function canonicalPath(path: string): string {
  const suffix: string[] = [];
  let current = resolve(path);
  while (true) {
    try { return join(realpathSync(current), ...suffix); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current)); current = parent;
    }
  }
}

/** Override enables clean-profile previews/tests without touching real user data. */
export function resolveUserDataPath(appDataPath: string, env: NodeJS.ProcessEnv): string {
  const legacyPath = join(appDataPath, APP_SUPPORT_DIR_NAME);
  const override = env.MELULI_USER_DATA?.trim();
  const mock = env.IVRIT_E2E_MOCK === "1" || env.IVRIT_USE_MOCK_SERVICES === "1";
  if (!override) {
    if (mock) throw new Error("Mock runs require an isolated MELULI_USER_DATA directory.");
    return legacyPath;
  }
  if (!isAbsolute(override)) throw new Error("MELULI_USER_DATA must be an absolute path.");
  if (mock) {
    const candidate = canonicalPath(override);
    const personal = canonicalPath(legacyPath);
    if (candidate === personal || candidate.startsWith(personal + sep)) {
      throw new Error("Mock runs cannot use the personal history directory.");
    }
  }
  return resolve(override);
}
