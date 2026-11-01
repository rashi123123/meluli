// Pinned, static arm64 whisper.cpp runtime. No Python, model weights or network code.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.build/whispercpp');
const output = join(root, 'resources/bin/whispercpp');
const licenses = join(root, 'resources/licenses/whispercpp');
for (const path of [cache, output, licenses]) await mkdir(path, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fetchPinned(url, path, sha) {
  if (existsSync(path) && sha256(await readFile(path)) === sha) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Source download failed: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== sha) throw new Error('Source checksum mismatch');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
}
const revision = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
const sourceSha = '645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4';
const archive = join(cache, revision + '.tar.gz');
await fetchPinned('https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/' + revision, archive, sourceSha);
execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', cache]);
const source = join(cache, 'whisper.cpp-' + revision);
const header = join(cache, 'include/nlohmann/json.hpp');
await fetchPinned('https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp', header,
  '9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6');
const build = join(cache, 'build');
execFileSync('cmake', ['-S', join(root,'native'), '-B', build, '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3',
  '-DGGML_METAL_MACOSX_VERSION_MIN=13.3', '-DWHISPER_SOURCE=' + source, '-DJSON_INCLUDE=' + join(cache,'include')], { stdio:'inherit' });
execFileSync('cmake', ['--build', build, '--target', 'meluli-asr-worker', 'meluli-worker-guard-test', '--parallel', '2'], { stdio:'inherit' });
execFileSync(join(build,'meluli-worker-guard-test'), { stdio:'inherit' });
const binary = join(output,'meluli-asr-worker');
await copyFile(join(build,'meluli-asr-worker'), binary);
// Static GGML/Whisper; every dynamic dependency must be supplied by macOS.
for (const line of execFileSync('/usr/bin/otool', ['-L',binary], {encoding:'utf8'}).split('\n').slice(1)) {
  const dependency = line.trim().split(' ')[0];
  if (dependency && !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')) throw new Error('Nonportable dependency: '+dependency);
}
execFileSync('/usr/bin/codesign', ['--force','--sign','-',binary]);
await copyFile(join(source,'LICENSE'), join(licenses,'whisper.cpp-LICENSE'));
// This upstream checkout licenses both Whisper and its GGML subtree in the root LICENSE.
await fetchPinned('https://raw.githubusercontent.com/nlohmann/json/v3.11.3/LICENSE.MIT', join(licenses,'nlohmann-json-LICENSE.MIT'),
  '86b998c792894ccb911a1cb7994f7a9652894e7a094c0b5e45be2f553f45cf14');
const bytes = await readFile(binary);
if (bytes.includes(Buffer.from(root))) throw new Error('Build contains a local source path');
await writeFile(join(licenses,'runtime.json'), JSON.stringify({engine:'whisper.cpp',version:'1.9.5',revision,sourceSha256:sourceSha,
  minimumMacOS:'13.3',architecture:'arm64',metalEmbedded:true,staticLibraries:true,sourcePathsRedacted:true,diskIoPolicy:'standard',
  binary:{name:'meluli-asr-worker',bytes:bytes.length,sha256:sha256(bytes)}},null,2)+'\n');
console.log('Built standalone Whisper Q8 runtime.');
