// Drives the streaming worker over its line protocol with a WAV file, as the app does during a dictation.
// node scripts/stream-worker-probe.mjs <modelDir> <wav> [--paced] [--file]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [modelDir, wavPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const paced = process.argv.includes('--paced'), fileMode = process.argv.includes('--file');
const worker = spawn(join(root, 'resources/bin/sherpa-onnx/meluli-asr-worker'), ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: worker.stdout });
const waiters = [];
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'partial') process.stdout.write(`\r\x1b[K… ${message.text}`);
  else if (message.type === 'segment') console.log(`\n■ ${message.segment.start.toFixed(2)}–${message.segment.end.toFixed(2)} ${message.segment.text}`);
  for (const waiter of [...waiters]) if (waiter.test(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
});
const send = value => worker.stdin.write(JSON.stringify(value) + '\n');
const until = test => new Promise(resolve => waiters.push({ test, resolve }));

await until(m => m.type === 'ready');
let t = performance.now();
send({ type: 'warmup', jobId: 'w', modelPath: modelDir });
console.log('warmed', (await until(m => m.type === 'warmed' || m.type === 'error')), Math.round(performance.now() - t), 'ms');
if (fileMode) {
  t = performance.now();
  send({ type: 'transcribe', jobId: 'f', wavPath: resolve(wavPath), modelPath: modelDir });
  const result = await until(m => m.jobId === 'f' && (m.type === 'result' || m.type === 'error'));
  console.log(JSON.stringify(result, null, 1), Math.round(performance.now() - t), 'ms');
} else {
  const wav = readFileSync(wavPath);
  const data = wav.indexOf('data') + 8;
  const pcm = wav.subarray(data);
  send({ type: 'begin', sessionId: 's1', modelPath: modelDir });
  await until(m => m.type === 'begun');
  const step = 2048 * 2;
  let seq = 0;
  for (let offset = 0; offset < pcm.length; offset += step) {
    send({ type: 'audio', sessionId: 's1', seq: seq++, pcm: Buffer.from(pcm.subarray(offset, offset + step)).toString('base64') });
    if (paced) await new Promise(r => setTimeout(r, 128));
  }
  t = performance.now();
  send({ type: 'finish', sessionId: 's1', samples: pcm.length / 2 });
  const final = await until(m => m.sessionId === 's1' && (m.type === 'final' || m.type === 'error'));
  console.log('\nFINAL', JSON.stringify(final), Math.round(performance.now() - t), 'ms stop→final');
}
worker.stdin.end();
