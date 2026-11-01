"""Export one commit to a source ZIP, without reading the working tree.
Usage: python3 scripts/export-source.py <commit> /absolute/output/Meluli-source.zip
Never uses git reset/clean, and never overwrites an existing archive.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
if len(sys.argv) != 3 or not Path(sys.argv[2]).is_absolute():
    raise SystemExit('Provide a commit and an absolute destination ZIP path.')
target = Path(sys.argv[2])
if target.exists():
    raise SystemExit('Destination already exists; choose a new path.')
resolved = subprocess.run(['git', 'rev-parse', '--verify', '--quiet', sys.argv[1] + '^{commit}'],
                          cwd=root, capture_output=True, text=True)
if resolved.returncode != 0:
    raise SystemExit('Not a commit: ' + sys.argv[1])
commit = resolved.stdout.strip()
for entry in subprocess.check_output(['git', 'ls-tree', '-r', '-z', commit], cwd=root).decode().split('\0'):
    if entry.startswith('120000 '):
        raise SystemExit('Review symlink before source export: ' + entry.split('\t', 1)[1])
version = json.loads(subprocess.check_output(['git', 'show', commit + ':package.json'], cwd=root))['version']
prefix = 'Meluli-' + version + '/'
payload = subprocess.check_output(['git', 'archive', '--format=zip', '--prefix=' + prefix, commit], cwd=root)
target.parent.mkdir(parents=True, exist_ok=True)
with open(target, 'xb') as output:
    output.write(payload)
with zipfile.ZipFile(target, 'a', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    manifest_name = prefix + 'SOURCE-MANIFEST.json'
    if manifest_name in archive.namelist():
        target.unlink()
        raise SystemExit('The commit already tracks SOURCE-MANIFEST.json.')
    inventory = []
    for name in archive.namelist():
        if not name.endswith('/'):
            data = archive.read(name)
            inventory.append({'path': name[len(prefix):], 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    archive.writestr(manifest_name, json.dumps({'version': version, 'commit': commit, 'files': inventory}, indent=2) + '\n')
print(json.dumps({'archive': str(target), 'commit': commit, 'files': len(inventory),
                  'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}))
