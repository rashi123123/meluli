import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'resources/licenses/npm');
const roots = ['better-sqlite3', 'zod', 'react', 'react-dom', '@base-ui/react', 'clsx', 'tailwind-merge', 'tailwindcss', 'tw-animate-css', 'shadcn'];
// shadcn is used for its CSS only; its CLI and CLI dependency graph are not bundled.
const leafOnly = new Set(['shadcn', 'tailwindcss', 'tw-animate-css']);
const seen = new Map();
function packageDirectory(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  try { return dirname(require.resolve(`${name}/package.json`)); } catch {}
  let current = parent;
  while (true) {
    const path = join(current, 'node_modules', name);
    if (existsSync(join(path, 'package.json'))) return realpathSync(path);
    const next = dirname(current); if (next === current) break; current = next;
  }
  throw new Error(`Cannot resolve required package ${name}`);
}
async function visit(name, parent) {
  const directory = packageDirectory(name, parent);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const entry = { name: pkg.name, version: pkg.version, license: pkg.license ?? null,
    repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null,
    directory, notices: [] };
  seen.set(key, entry);
  for (const file of (await readdir(directory)).sort()) {
    if (!/^(licen[cs]e|copying|notice)([._-].*)?$/i.test(file)) continue;
    const path = join(directory, file);
    if ((await stat(path)).isFile()) entry.notices.push({ name: file, bytes: await readFile(path) });
  }
  if (!entry.notices.length) throw new Error(`Missing license text for ${key}; add an explicit reviewed notice before packaging.`);
  if (!leafOnly.has(name)) for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) await visit(dependency, directory);
}
for (const name of roots) await visit(name, root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const inventory = [];
for (const entry of [...seen.values()].sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
  const folder = `${entry.name.replaceAll('/', '__').replaceAll('@', '')}@${entry.version}`;
  await mkdir(join(output, folder), { recursive: true });
  const notices = [];
  for (const file of entry.notices) {
    await writeFile(join(output, folder, file.name), file.bytes);
    notices.push({ path: `${folder}/${file.name}`, sha256: createHash('sha256').update(file.bytes).digest('hex') });
  }
  inventory.push({ name: entry.name, version: entry.version, license: entry.license, repository: entry.repository, notices });
}
await writeFile(join(output, 'inventory.json'), JSON.stringify({ scope: 'Native Node runtime dependencies and renderer/CSS source dependencies; build-only tooling excluded. Electron/Chromium notices ship separately.', packages: inventory }, null, 2) + '\n');
console.log(`Collected ${inventory.length} package notices in ${relative(root, output)}.`);
