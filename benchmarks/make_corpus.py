"""A reproducible public Hebrew corpus; no personal recordings or synthesized speech."""
import hashlib
import io
import json
from pathlib import Path
import re
import wave

import av
import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent
audio_dir = ROOT/'audio'
audio_dir.mkdir(exist_ok=True)
rows = pq.read_table(ROOT/'dataset/0000.parquet').to_pylist()
eligible = [(index, row) for index, row in enumerate(rows) if 3 <= row['num_samples']/16000 <= 18]
selected, seen = [], set()
def add(index, row):
    if row['id'] in seen: return
    selected.append((index, row)); seen.add(row['id'])

# Select before inspecting ASR output, with named/numeric/code-switch prompts represented.
for regex in (r'[A-Za-z]{2,}', r'\d'):
    count = 0
    for index, row in eligible:
        if re.search(regex, row['raw_transcription']) and row['id'] not in seen:
            add(index, row); count += 1
            if count == 6: break
for index, row in eligible:
    if len(selected) == 36: break
    add(index, row)

manifest = []
waves = []
def save(name, data, reference, kind, **extra):
    pcm = (np.clip(data, -1, 1) * 32767).astype('<i2')
    path = audio_dir/f'{name}.wav'
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000); out.writeframes(pcm.tobytes())
    manifest.append({'id':name, 'path':str(path.relative_to(ROOT)), 'duration_sec':len(pcm)/16000,
                     'reference':reference, 'kind':kind, 'sha256':hashlib.sha256(path.read_bytes()).hexdigest(), **extra})

for number, (index, row) in enumerate(selected):
    with av.open(io.BytesIO(row['audio']['bytes'])) as source:
        resampler = av.AudioResampler(format='fltp', layout='mono', rate=16000)
        frames = [f.to_ndarray().flatten() for frame in source.decode(audio=0) for f in resampler.resample(frame)]
        frames += [f.to_ndarray().flatten() for f in resampler.resample(None)]
    data = np.concatenate(frames)
    waves.append(data)
    save(f'he-{number:02d}', data, row['raw_transcription'], 'human_read_speech', row_index=index,
         fleurs_id=row['id'], gender=row['gender'], source_audio=row['audio']['path'],
         has_latin=bool(re.search(r'[A-Za-z]',row['raw_transcription'])), has_digits=bool(re.search(r'\d',row['raw_transcription'])))

rng = np.random.default_rng(20261024)
for i in range(8):
    data=waves[i]
    noise=rng.normal(0,1,len(data))
    noise *= np.sqrt(np.mean(data**2)) / (np.sqrt(np.mean(noise**2)) * 10**(15/20))
    save(f'noise-{i:02d}', data+noise, manifest[i]['reference'], 'derived_noise', source=f'he-{i:02d}', snr_db=15)
for duration in (2, 5, 15):
    save(f'silence-{duration}', np.zeros(duration*16000), '', 'silence')
save('room-noise', rng.normal(0,0.003,5*16000), '', 'noise_only')
long_audio=np.concatenate([part for data in waves for part in (data,np.zeros(8000))])
save('long-concatenated',long_audio,' '.join(row['raw_transcription'] for _,row in selected),'derived_long',
     note='Concatenation of all 36 distinct clips with 0.5s gaps; not a continuous natural conversation.')
source=json.loads((ROOT/'fleurs-source.json').read_text())
result={'dataset':'google/fleurs', 'config':'he_il', 'split':'test', 'revision':source['revision'],
        'license':'CC-BY-4.0', 'attribution':'FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech, Conneau et al., 2022, Google',
        'limitations':['Read speech is not spontaneous dictation. Latin tokens in references do not prove the speaker used English pronunciation.',
                      'Noise is deterministic additive Gaussian noise, not recorded environmental noise.',
                      'No numeric semantic normalization is used in WER; digit versus word spelling counts as an error.'],
        'samples':manifest}
(ROOT/'corpus.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'samples':len(manifest),'human':len(selected),'seconds':sum(x['duration_sec'] for x in manifest),
                  'latin_references':sum(x.get('has_latin',False) for x in manifest), 'numeric_references':sum(x.get('has_digits',False) for x in manifest)}))
