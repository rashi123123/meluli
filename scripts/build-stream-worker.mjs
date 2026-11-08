// Pinned, static arm64 sherpa-onnx runtime for the streaming zipformer worker. No Python, model weights or network code.
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.build/sherpa-onnx');
const output = join(root, 'resources/bin/sherpa-onnx');
const licenses = join(root, 'resources/licenses/sherpa-onnx');
for (const path of [cache, output, licenses]) await mkdir(path, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fetchPinned(url, path, sha) {
  if (existsSync(path) && sha256(await readFile(path)) === sha) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok) throw new Error('Download failed: ' + response.status + ' ' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== sha) throw new Error('Checksum mismatch: ' + url);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

// Official k2-fsa release; the digest is the one GitHub publishes for the asset.
const version = '1.12.30';
const name = `sherpa-onnx-v${version}-osx-universal2-static-no-tts`;
const archiveSha = 'c1ac6bd6318c12cc4a45012fc452703e00210c37ad90a1396b130a25ff1e1de4';
const archive = join(cache, name + '.tar.bz2');
await fetchPinned(`https://github.com/k2-fsa/sherpa-onnx/releases/download/v${version}/${name}.tar.bz2`, archive, archiveSha);
const sdk = join(cache, name);
await rm(sdk, { recursive: true, force: true });
execFileSync('/usr/bin/tar', ['-xjf', archive, '-C', cache]);

const header = join(cache, 'include/nlohmann/json.hpp');
await fetchPinned('https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp', header,
  '9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6');

const lib = join(sdk, 'lib');
// The C API and what it needs for an online transducer; TTS, portaudio and the C++ wrapper stay out.
const archives = ['libsherpa-onnx-c-api.a', 'libsherpa-onnx-core.a', 'libsherpa-onnx-fstfar.a', 'libsherpa-onnx-fst.a',
  'libsherpa-onnx-kaldifst-core.a', 'libkaldi-decoder-core.a', 'libkaldi-native-fbank-core.a', 'libkissfft-float.a',
  'libssentencepiece_core.a', 'libonnxruntime.a'].map(file => join(lib, file));
const build = join(cache, 'build');
await mkdir(build, { recursive: true });

function compile(source, out) {
  execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-O2', '-arch', 'arm64', '-mmacosx-version-min=13.3',
    `-ffile-prefix-map=${root}=/meluli-src`, `-fdebug-prefix-map=${root}=/meluli-src`, '-Wall', '-Wextra', '-Wno-unused-parameter',
    '-I', join(sdk, 'include'), '-I', join(cache, 'include'), source, ...archives,
    '-framework', 'Foundation', '-framework', 'CoreFoundation', '-lc++', '-dead_strip', '-o', out], { stdio: 'inherit' });
}
const built = join(build, 'meluli-asr-worker');
compile(join(root, 'native/stream-worker.cpp'), built);
execFileSync('/usr/bin/strip', ['-x', built]);

const binary = join(output, 'meluli-asr-worker');
await copyFile(built, binary);
// Static sherpa-onnx and ONNX Runtime; every dynamic dependency must be supplied by macOS.
for (const line of execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' }).split('\n').slice(1)) {
  const dependency = line.trim().split(' ')[0];
  if (dependency && !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')) throw new Error('Nonportable dependency: ' + dependency);
}
const minos = execFileSync('/usr/bin/vtool', ['-show-build', binary], { encoding: 'utf8' }).match(/minos (\S+)/)?.[1];
if (minos !== '13.3') throw new Error('Unexpected minimum macOS: ' + minos);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
const bytes = await readFile(binary);
if (bytes.includes(Buffer.from(root))) throw new Error('Build contains a local source path');

// sherpa-onnx (Apache-2.0) bundles ONNX Runtime (MIT) and its own pinned dependencies.
await fetchPinned(`https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v${version}/LICENSE`, join(licenses, 'sherpa-onnx-LICENSE'),
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
await fetchPinned('https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/LICENSE', join(licenses, 'onnxruntime-LICENSE'),
  '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c');
await fetchPinned('https://raw.githubusercontent.com/nlohmann/json/v3.11.3/LICENSE.MIT', join(licenses, 'nlohmann-json-LICENSE.MIT'),
  '86b998c792894ccb911a1cb7994f7a9652894e7a094c0b5e45be2f553f45cf14');
// The libraries linked from the sherpa-onnx static archive, at the versions its CMake pins.
const notices = [
  ['https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/ThirdPartyNotices.txt', 'onnxruntime-ThirdPartyNotices.txt', 'e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc'],
  ['https://raw.githubusercontent.com/csukuangfj/kaldi-native-fbank/v1.22.3/LICENSE', 'kaldi-native-fbank-LICENSE', 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
  ['https://raw.githubusercontent.com/k2-fsa/kaldi-decoder/v0.2.11/LICENSE', 'kaldi-decoder-LICENSE', 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
  ['https://raw.githubusercontent.com/k2-fsa/kaldifst/v1.7.17/LICENSE', 'kaldifst-LICENSE', 'a682d6efd1ee5dee08a8e405c233c2c198ea70ae0718129daa83ab58cfe31c5d'],
  ['https://raw.githubusercontent.com/csukuangfj/openfst/sherpa-onnx-2024-06-19/COPYING', 'openfst-COPYING', '9ba732713e5a28a183907aaba134490900bc258310a8fb37a391b47bc1c7f951'],
  ['https://raw.githubusercontent.com/pkufool/simple-sentencepiece/v0.7/LICENSE', 'simple-sentencepiece-LICENSE', 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'],
  ['https://raw.githubusercontent.com/mborgerding/kissfft/febd4caeed32e33ad8b2e0bb5ea77542c40f18ec/COPYING', 'kissfft-COPYING', 'a2840585f8411be8e6826a31ef15ae65c950bd74a2437a73b013398a934ad0c6'],
  ['https://raw.githubusercontent.com/mborgerding/kissfft/febd4caeed32e33ad8b2e0bb5ea77542c40f18ec/LICENSES/BSD-3-Clause', 'kissfft-BSD-3-Clause', '4d6bcab46f27d6d0c878e8305d4bdcfe040d52bf6656b9771f04c9fb9902c0ed']
];
for (const [url, file, sha] of notices) await fetchPinned(url, join(licenses, file), sha);
await writeFile(join(licenses, 'runtime.json'), JSON.stringify({ engine: 'sherpa-onnx', version, archive: name + '.tar.bz2',
  archiveSha256: archiveSha, minimumMacOS: '13.3', architecture: 'arm64', staticLibraries: true, sourcePathsRedacted: true,
  diskIoPolicy: 'standard', binary: { name: 'meluli-asr-worker', bytes: bytes.length, sha256: sha256(bytes) } }, null, 2) + '\n');
console.log(`Built streaming sherpa-onnx ${version} worker (${(bytes.length / 1048576).toFixed(1)} MiB).`);
