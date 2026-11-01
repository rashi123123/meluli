"""Score all saved engines with one normalization and corpus; never change raw results."""
import json, math, statistics, unicodedata
from pathlib import Path
ROOT=Path(__file__).resolve().parent
corpus={s['id']:s for s in json.loads((ROOT/'corpus.json').read_text())['samples']}
def normalize(text):
 text=unicodedata.normalize('NFKC',text).lower()
 return ' '.join(''.join(c if c.isalnum() or c.isspace() else '' if c in "'׳\u05f4\"" or unicodedata.category(c).startswith('M') else ' ' for c in text).split())
def distance(a,b):
 prev=list(range(len(b)+1))
 for i,x in enumerate(a,1):
  row=[i]
  for j,y in enumerate(b,1): row.append(min(row[-1]+1,prev[j]+1,prev[j-1]+(x!=y)))
  prev=row
 return prev[-1]
def group_score(rows):
 times=sorted(s['seconds'] for s in rows)
 words=sum(s['reference_words'] for s in rows); chars=sum(s['reference_characters'] for s in rows)
 return {'samples':len(rows),'wer_percent':100*sum(s['word_errors'] for s in rows)/words if words else None,
         'cer_percent':100*sum(s['character_errors'] for s in rows)/chars if chars else None,
         'median_seconds':statistics.median(times) if times else None,
         'p95_seconds_nearest_rank':times[math.ceil(.95*len(times))-1] if times else None,
         'text_on_silence_or_noise':sum(s['hallucination_on_silence'] for s in rows)}
results={}
for path in sorted((ROOT/'results').glob('*.json')):
 if path.name.startswith(('statuses','scores')): continue
 try: source=json.loads(path.read_text())
 except json.JSONDecodeError: continue
 if not source.get('samples') or any('kind' not in sample for sample in source['samples']): continue
 rows=[]
 for sample in source['samples']:
  ref=normalize(corpus[sample['id']]['reference']); hyp=normalize(sample['text'])
  rows.append({**sample,'word_errors':distance(ref.split(),hyp.split()),'reference_words':len(ref.split()),
               'character_errors':distance(ref,hyp),'reference_characters':len(ref),
               'hallucination_on_silence':not ref and bool(hyp)})
 groups={kind:group_score([s for s in rows if s['kind']==kind]) for kind in sorted({s['kind'] for s in rows})}
 groups['short_speech']=group_score([s for s in rows if s['kind'] in ('human_read_speech','derived_noise')])
 groups['warm_human']=group_score([s for s in rows if s['kind']=='human_read_speech' and not s.get('first_inference')])
 results[path.stem]={'complete':len(rows)==len(corpus),'load_seconds':source.get('load_sec'),
                    'groups':groups,'samples':rows,'raw_result':path.name}
(ROOT/'results/scores.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
for label,data in results.items():
 group=data['groups'].get('human_read_speech',{});warm=data['groups']['warm_human']
 print(label, json.dumps({'complete':data['complete'],'human_wer':round(group.get('wer_percent') or 0,2),
       'warm_p50':round(warm.get('median_seconds') or 0,2),'warm_p95':round(warm.get('p95_seconds_nearest_rank') or 0,2),
       'silence_noise_texts':sum(s['hallucination_on_silence'] for s in data['samples'])}))
