import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerifiedModel } from '../src/main/services/verified-download.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'src/shared/model-manifest.json'), 'utf8'));
const target = process.argv[2];
if (!target) throw new Error('Pass an explicit model directory: pnpm fetch:model /absolute/profile/models/ivrit-whisper-large-v3-turbo-q8');
const abort = new AbortController();
process.once('SIGINT', () => abort.abort(new Error('Download canceled. Partial bytes can be resumed.')));
let last = -1;
await downloadVerifiedModel(manifest, resolve(target), abort.signal, (bytes, total) => {
  const percent = Math.floor(bytes / total * 100);
  if (percent >= last + 10 || percent === 100) { console.log(percent + '%'); last = percent; }
});
console.log('Pinned model verified.');
