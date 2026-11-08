// Streaming zipformer vs Whisper on identical audio, through the real worker binaries and their
// line protocols. Accuracy hypotheses go to <phase4>/results/accuracy/<name>.jsonl for score.py;
// latency, CPU, memory, startup and the acceptance scenarios go to --out as JSON.
//
// node scripts/asr-streaming-bench.mjs --zip-model <dir>/sherpa-onnx --whisper-worker <bin> \
//   --whisper-model <dir> --phase4 <dir> --out <file.json> [--quick]
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const quick = process.argv.includes('--quick');
const only = arg('only', 'startup,accuracy,latency,threads,tail,scenarios').split(',');
const zipModel = resolve(arg('zip-model'));
const zipWorker = resolve(arg('zip-worker', join(root, 'resources/bin/sherpa-onnx/meluli-asr-worker')));
const whisperWorker = arg('whisper-worker') && resolve(arg('whisper-worker'));
const whisperModel = arg('whisper-model') && resolve(arg('whisper-model'));
const phase4 = resolve(arg('phase4', join(root, '.build/phase4')));
const out = resolve(arg('out', join(phase4, 'results/streaming/bench.json')));
const scratch = join(dirname(out), 'wav');
mkdirSync(scratch, { recursive: true });
const RATE = 16000, STEP = 2048;
// About 10x real time: far faster than speech, inside the worker's 30 s queue bound.
const FAST = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const pct = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : null; };
const round = v => v == null ? null : Math.round(v * 10) / 10;

// ---------- audio ----------
function readWav(path) {
  const b = readFileSync(path);
  let o = 12, data = null;
  while (o < b.length - 8) { const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4); if (id === 'data') { data = b.subarray(o + 8, o + 8 + size); break; } o += 8 + size + (size & 1); }
  return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
}
function writeWav(path, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40);
  writeFileSync(path, Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
  return path;
}
const silence = sec => new Int16Array(Math.round(sec * RATE));
const concat = parts => { const o = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const gain = (pcm, g) => Int16Array.from(pcm, v => Math.max(-32768, Math.min(32767, Math.round(v * g))));
function addNoise(pcm, snrDb, seed = 7) {
  let s = seed, power = 0; for (const v of pcm) power += v * v; power /= pcm.length;
  const sigma = Math.sqrt(power / 10 ** (snrDb / 10));
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Int16Array.from(pcm, v => { const n = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); return Math.max(-32768, Math.min(32767, Math.round(v + n * sigma))); });
}

// ---------- workers ----------
class Worker {
  constructor(binary) {
    this.spawnedAt = now();
    this.child = spawn(binary, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.waiters = []; this.log = [];
    this.exited = new Promise(r => this.child.on('exit', (code, signal) => r({ code, signal })));
    createInterface({ input: this.child.stdout }).on('line', line => {
      const m = JSON.parse(line); m.at = now(); this.log.push(m);
      if (this.log.length > 20000) this.log.splice(0, 10000);
      for (const w of [...this.waiters]) if (w.test(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
    });
    this.samples = []; this.sampler = setInterval(() => this.sample(), 100);
  }
  get pid() { return this.child.pid; }
  send(v) { return this.child.stdin.write(JSON.stringify(v) + '\n'); }
  until(test, ms = 120000) {
    return new Promise((res, rej) => { const w = { test, resolve: m => { clearTimeout(t); res(m); } }; const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms); this.waiters.push(w); });
  }
  sample() {
    try {
      const [rss, time] = execFileSync('/bin/ps', ['-o', 'rss=,time=', '-p', String(this.pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      const [m, s] = time.split(':'); this.samples.push({ at: now(), rss: Number(rss) * 1024, cpu: Number(m) * 60 + Number(s) });
    } catch { /* exited */ }
  }
  cpuNow() { this.sample(); return this.samples.at(-1)?.cpu ?? 0; }
  rssNow() { this.sample(); return this.samples.at(-1)?.rss ?? 0; }
  peakRss(from = 0) { return Math.max(0, ...this.samples.filter(s => s.at >= from).map(s => s.rss)); }
  async close() { clearInterval(this.sampler); this.child.stdin.end(); await Promise.race([this.exited, sleep(3000)]); this.child.kill('SIGKILL'); }
}
let ids = 0;
async function start(engine, options = {}) {
  const w = new Worker(engine === 'zip' ? zipWorker : whisperWorker);
  const ready = await w.until(m => m.type === 'ready', 30000);
  const readyMs = ready.at - w.spawnedAt;
  const jobId = 'w' + ids++;
  const t = now();
  w.send({ type: 'warmup', jobId, modelPath: engine === 'zip' ? zipModel : whisperModel, useGpu: true, ...options });
  const warmed = await w.until(m => m.jobId === jobId && (m.type === 'warmed' || m.type === 'error'), 180000);
  if (warmed.type !== 'warmed') throw new Error('warmup failed: ' + JSON.stringify(warmed));
  w.startup = { readyMs: round(readyMs), warmupMs: round(now() - t), rssAfterWarmup: w.rssNow() };
  return w;
}
async function fileJob(w, engine, wavPath, options = {}) {
  const jobId = 'f' + ids++, t = now();
  w.send({ type: 'transcribe', jobId, wavPath, modelPath: engine === 'zip' ? zipModel : whisperModel, useGpu: true, ...options });
  const m = await w.until(x => x.jobId === jobId && ['result', 'error', 'canceled'].includes(x.type), 600000);
  return { ms: now() - t, text: m.result?.text ?? '', message: m };
}
/** One live dictation. `pace` is ms per 2048-sample chunk (128 = real time, 0 = as fast as possible). */
async function liveSession(w, pcm, { pace = 0, options = {}, stopAfter = null, killAt = null } = {}) {
  const sessionId = 's' + ids++;
  const events = [];
  const listen = m => { if (m.sessionId === sessionId) events.push(m); return false; };
  w.waiters.push({ test: listen, resolve: () => {} });
  w.send({ type: 'begin', sessionId, modelPath: zipModel, ...options });
  await w.until(m => m.sessionId === sessionId && (m.type === 'begun' || m.type === 'error'), 30000);
  const total = stopAfter == null ? pcm.length : Math.min(pcm.length, Math.round(stopAfter * RATE));
  const startedAt = now(); let seq = 0, sentAt = [];
  for (let o = 0; o < total; o += STEP) {
    const part = pcm.subarray(o, Math.min(total, o + STEP));
    w.send({ type: 'audio', sessionId, seq, pcm: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString('base64') });
    sentAt[seq++] = now();
    if (killAt != null && o / RATE >= killAt) { w.child.kill('SIGKILL'); return { killed: true, exit: await w.exited, events }; }
    if (pace) { const due = startedAt + seq * pace; const wait = due - now(); if (wait > 0) await sleep(wait); }
  }
  const finalBeforeStop = events.some(e => e.type === 'final');
  const stopAt = now();
  w.send({ type: 'finish', sessionId, samples: total });
  const final = await w.until(m => m.sessionId === sessionId && (m.type === 'final' || m.type === 'error'), 120000);
  w.waiters.splice(w.waiters.findIndex(x => x.test === listen), 1);
  const partials = events.filter(e => e.type === 'partial');
  const segments = events.filter(e => e.type === 'segment').map(e => ({ ...e.segment, at: e.at - startedAt }));
  return {
    final, text: final.result?.text ?? '', stopMs: final.at - stopAt, finishMs: final.timing?.finishMs ?? null,
    finalBeforeStop, segments, partialCount: partials.length,
    partialLagMs: partials.map(p => p.at - sentAt[p.seq]).filter(Number.isFinite),
    audioSec: total / RATE
  };
}

// ---------- corpus ----------
const manifest = JSON.parse(readFileSync(join(phase4, 'corpus/manifest.json'), 'utf8'));
const clips = [...new Map(manifest.map(r => [r.id, r])).values()];
const audioOf = new Map();
const pcmOf = r => { if (!audioOf.has(r.id)) audioOf.set(r.id, readWav(r.path)); return audioOf.get(r.id); };
const results = { machine: { cpu: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(), macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() }, startedAt: new Date().toISOString() };
const save = () => writeFileSync(out, JSON.stringify(results, null, 1) + '\n');
const jsonl = (name, rows) => writeFileSync(join(phase4, 'results/accuracy', name + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

function stratified(n, maxSec) {
  const kinds = ['read', 'natural', 'tts_he', 'tts_mixed', 'tts_technical', 'padded'];
  const pick = [];
  for (let i = 0; pick.length < n && i < 50; i += 1) for (const k of kinds) {
    const c = clips.filter(r => r.kind === k && r.seconds <= maxSec)[i];
    if (c && pick.length < n) pick.push(c);
  }
  return pick;
}

// ---------- 1. startup ----------
if (only.includes('startup')) {
  results.startup = {};
  for (const engine of ['zip', ...(whisperWorker ? ['whisper'] : [])]) {
    const runs = [];
    for (let i = 0; i < 3; i += 1) { const w = await start(engine); runs.push(w.startup); await w.close(); }
    results.startup[engine] = { runs, readyMsP50: pct(runs.map(r => r.readyMs), 50), warmupMsP50: pct(runs.map(r => r.warmupMs), 50), rssAfterWarmupMiB: round(pct(runs.map(r => r.rssAfterWarmup), 50) / 1048576) };
  }
  save(); console.log('startup', JSON.stringify(results.startup));
}

// ---------- 2. accuracy through the real worker (live sessions, unpaced) ----------
async function accuracyRun(name, options = {}, mode = 'live') {
  const w = await start('zip', options);
  const rows = [];
  const cpu0 = w.cpuNow(), t0 = now();
  let audioSec = 0, finishMs = []; const errors = [];
  for (const r of clips) {
    const pcm = pcmOf(r);
    let text, segments = null;
    if (mode === 'live') { const s = await liveSession(w, pcm, { options, pace: FAST }); text = s.text; segments = s.segments.length; finishMs.push(s.finishMs); if (s.final.type !== 'final') errors.push({ id: r.id, code: s.final.code }); }
    else text = (await fileJob(w, 'zip', r.path, options)).text;
    audioSec += pcm.length / RATE;
    rows.push({ id: r.id, text: JSON.stringify(text), segments, inputSec: pcm.length / RATE });
  }
  const summary = { name, options, mode, clips: rows.length, audioSec: round(audioSec), wallSec: round((now() - t0) / 1000), cpuSec: round(w.cpuNow() - cpu0), peakRssMiB: round(w.peakRss() / 1048576), finishMsP50: round(pct(finishMs, 50)), finishMsP95: round(pct(finishMs, 95)), errors };
  summary.rtf = round(summary.wallSec / summary.audioSec * 1000) / 1000;
  await w.close();
  jsonl(name, rows);
  return summary;
}
if (only.includes('accuracy')) {
  results.accuracy = [await accuracyRun('zw-live'), await accuracyRun('zw-file', {}, 'file')];
  save(); console.log('accuracy', JSON.stringify(results.accuracy));
}
if (only.includes('threads')) {
  results.threads = [];
  for (const threads of [1, 2, 4]) results.threads.push(await accuracyRun('zw-live-t' + threads, { threads }));
  save(); console.log('threads', JSON.stringify(results.threads));
}
if (only.includes('tail')) {
  // The silence added at stop so the last word is decoded: the hangover the person never waits through.
  results.tail = [];
  for (const tailSec of [0.4, 0.6, 1.0]) results.tail.push(await accuracyRun('zw-live-tail' + String(tailSec).replace('.', ''), { tailSec }));
  for (const pauseSec of [0.6, 0.8, 1.6]) results.tail.push(await accuracyRun('zw-live-pause' + String(pauseSec).replace('.', ''), { pauseSec }));
  save(); console.log('tail', JSON.stringify(results.tail));
}

// ---------- 3. stop latency, CPU and memory, real-time paced ----------
if (only.includes('latency')) {
  const set = [...stratified(quick ? 6 : 24, 15), ...clips.filter(r => r.kind === 'long').slice(0, quick ? 1 : 3)];
  results.latency = { clips: set.map(r => r.id) };
  for (const engine of ['zip', ...(whisperWorker ? ['whisper'] : [])]) {
    const w = await start(engine);
    const idle0 = w.rssNow(), cpu0 = w.cpuNow(), t0 = now();
    const stopMs = [], lag = [], perClip = [];
    let audioSec = 0;
    for (const r of set) {
      const pcm = pcmOf(r);
      if (engine === 'zip') {
        const s = await liveSession(w, pcm, { pace: 128 });
        stopMs.push(s.stopMs); lag.push(...s.partialLagMs);
        perClip.push({ id: r.id, sec: r.seconds, stopMs: round(s.stopMs), segments: s.segments.length });
      } else {
        // Whisper's stop: the whole recording is decoded after the person stops.
        await sleep(r.seconds * 1000 * (quick ? 0 : 0.1));
        const f = await fileJob(w, 'whisper', r.path);
        stopMs.push(f.ms); perClip.push({ id: r.id, sec: r.seconds, stopMs: round(f.ms) });
      }
      audioSec += r.seconds;
    }
    results.latency[engine] = {
      stopMsP50: round(pct(stopMs, 50)), stopMsP95: round(pct(stopMs, 95)), stopMsMax: round(Math.max(...stopMs)),
      partialLagMsP50: lag.length ? round(pct(lag, 50)) : null, partialLagMsP95: lag.length ? round(pct(lag, 95)) : null,
      cpuSecPerAudioSec: round((w.cpuNow() - cpu0) / audioSec * 1000) / 1000,
      idleRssMiB: round(idle0 / 1048576), peakRssMiB: round(w.peakRss(t0) / 1048576), perClip
    };
    await w.close();
    save(); console.log('latency', engine, JSON.stringify({ ...results.latency[engine], perClip: undefined }));
  }
}

// ---------- 4. acceptance scenarios ----------
if (only.includes('scenarios')) {
  const S = results.scenarios = {};
  const speech = clips.filter(r => ['read', 'natural'].includes(r.kind));
  const [a, b, c, d] = [speech[0], speech[1], speech[2], speech[3]].map(pcmOf);
  const shortest = clips.filter(r => r.kind !== 'silence').sort((x, y) => x.seconds - y.seconds)[0];
  const w = await start('zip');
  const check = (name, value) => { S[name] = value; console.log('scenario', name, JSON.stringify(value).slice(0, 300)); };
  const whisperText = async pcm => whisperWorker ? (await fileJob(wh, 'whisper', writeWav(join(scratch, 'scn-' + ids++ + '.wav'), pcm))).text : null;
  const wh = whisperWorker ? await start('whisper') : null;
  const ref = r => r.reference;

  // short speech
  let s = await liveSession(w, pcmOf(shortest), { pace: 128 });
  check('short_speech', { id: shortest.id, sec: shortest.seconds, text: s.text, reference: ref(shortest), stopMs: round(s.stopMs), whisper: await whisperText(pcmOf(shortest)) });

  // long silence between two utterances: the first is finalized during the silence, nothing ends
  const longSilence = concat([a, silence(20), b]);
  s = await liveSession(w, longSilence, { pace: 32 });
  check('long_silence', {
    pass: !s.finalBeforeStop && s.segments.length >= 2 && s.text === s.segments.map(x => x.text).join(' '),
    finalBeforeStop: s.finalBeforeStop, segments: s.segments.map(x => ({ start: round(x.start), end: round(x.end), atSec: round(x.at / 1000 * 4) })),
    text: s.text, whisper: await whisperText(longSilence)
  });

  // several pauses
  const pauses = concat([a, silence(1.5), b, silence(1.5), c, silence(1.5), d]);
  s = await liveSession(w, pauses, { pace: FAST });
  check('multiple_pauses', { pass: !s.finalBeforeStop && s.segments.length >= 4 && new Set(s.segments.map(x => x.text)).size === s.segments.length, segments: s.segments.length, text: s.text, whisper: await whisperText(pauses) });

  // pure silence, and silence before and after speech
  s = await liveSession(w, silence(10));
  check('pure_silence', { pass: s.text === '' && s.segments.length === 0, text: s.text, whisper: await whisperText(silence(10)) });

  // quiet speech and noise
  for (const [name, pcm] of [['quiet_-20dB', gain(a, 0.1)], ['quiet_-30dB', gain(a, 0.0316)], ['noise_10dB', addNoise(a, 10)], ['noise_5dB', addNoise(a, 5)]]) {
    s = await liveSession(w, pcm, { pace: FAST });
    check(name, { text: s.text, reference: ref(speech[0]), whisper: await whisperText(pcm) });
  }

  // rapid stop: 0.4 s into speech, and the stop sent with the last chunk (no trailing silence)
  s = await liveSession(w, a, { stopAfter: 0.4 });
  check('rapid_stop_0.4s', { pass: s.final.type === 'final', stopMs: round(s.stopMs), text: s.text });
  s = await liveSession(w, a, { pace: 128 });
  check('stop_on_last_word', { stopMs: round(s.stopMs), text: s.text, reference: ref(speech[0]) });

  // repeated sessions: same audio, same text, flat memory
  const texts = new Set(); const rss0 = w.rssNow();
  for (let i = 0; i < (quick ? 5 : 40); i += 1) texts.add((await liveSession(w, b)).text);
  check('repeated_sessions', { pass: texts.size === 1, sessions: quick ? 5 : 40, distinctTexts: texts.size, rssGrowthMiB: round((w.rssNow() - rss0) / 1048576) });

  // cancel mid-session, then a new session on the same worker
  const cid = 'c' + ids++;
  w.send({ type: 'begin', sessionId: cid, modelPath: zipModel });
  await w.until(m => m.sessionId === cid && m.type === 'begun');
  w.send({ type: 'audio', sessionId: cid, seq: 0, pcm: Buffer.from(a.buffer, a.byteOffset, STEP * 2).toString('base64') });
  w.send({ type: 'cancel_session', sessionId: cid });
  const canceled = await w.until(m => m.sessionId === cid && m.type === 'canceled', 10000).then(() => true, () => false);
  s = await liveSession(w, b);
  check('cancel_then_new', { pass: canceled && texts.has(s.text), canceled });

  // out-of-order chunk: the session refuses to finish rather than return text with a hole
  const oid = 'o' + ids++;
  w.send({ type: 'begin', sessionId: oid, modelPath: zipModel });
  await w.until(m => m.sessionId === oid && m.type === 'begun');
  const pcm16 = n => Buffer.from(a.buffer, a.byteOffset + n * STEP * 2, STEP * 2).toString('base64');
  w.send({ type: 'audio', sessionId: oid, seq: 0, pcm: pcm16(0) });
  w.send({ type: 'audio', sessionId: oid, seq: 2, pcm: pcm16(2) });
  w.send({ type: 'finish', sessionId: oid, samples: STEP * 2 });
  const gap = await w.until(m => m.sessionId === oid && (m.type === 'final' || (m.type === 'error' && m.code === 'session_lost')));
  check('sequence_gap', { pass: gap.type === 'error', code: gap.code });

  // a burst far faster than the decoder (several minutes at once): text matches, or the session says it was lost
  const burst = concat(Array.from({ length: 12 }, (_, i) => pcmOf(speech[i % speech.length])));
  s = await liveSession(w, burst);
  check('backpressure_burst', { audioSec: round(burst.length / RATE), outcome: s.final.type, code: s.final.code ?? null, pass: s.final.type === 'final' || ['session_lost', 'backpressure'].includes(s.final.code) });
  await w.close();

  // crash mid-session: the process ends; the app decodes the recording in full (tests/unit/live-dictation*.test.ts)
  const victim = await start('zip');
  const crash = await liveSession(victim, a, { killAt: 1.0 });
  check('worker_crash', { killed: crash.killed, exit: crash.exit });
  await victim.close();
  if (wh) await wh.close();
  save();
}
results.finishedAt = new Date().toISOString();
save();
console.log('wrote', out);
