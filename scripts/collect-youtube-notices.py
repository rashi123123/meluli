"""Collect exact dependency notices for Meluli's minimal standalone media helper."""
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
output = root / 'resources/licenses/youtube'
output.mkdir(parents=True, exist_ok=True)
packages = []
# Include the build-tool licenses too, clearly identified; they are not all runtime modules.
for name in ['yt-dlp', 'yt-dlp-ejs', 'pycryptodomex', 'certifi', 'pyinstaller',
             'pyinstaller-hooks-contrib', 'setuptools', 'packaging', 'altgraph', 'macholib']:
    dist = metadata.distribution(name)
    notices = []
    for item in dist.files or []:
        if not any(word in item.name.lower() for word in ('license', 'copying', 'notice')):
            continue
        source = Path(dist.locate_file(item))
        if not source.is_file():
            continue
        target = output / (name + '-' + dist.version) / str(item).split('/', 1)[-1]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        notices.append({'path': str(target.relative_to(output)), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    if not notices:
        raise RuntimeError('Missing license for ' + name)
    packages.append({'name': name, 'version': dist.version, 'license': dist.metadata.get('License-Expression') or dist.metadata.get('License'), 'notices': notices})
# EJS preserves the full ISC/MIT licenses for its bundled JS dependencies in this comment.
ejs = metadata.distribution('yt-dlp-ejs')
lib = Path(ejs.locate_file('yt_dlp_ejs/yt/solver/lib.min.js')).read_text()
if not lib.startswith('/*!') or 'Bundled Dependencies:' not in lib:
    raise RuntimeError('Missing EJS bundled dependency notices')
(output / 'EJS-BUNDLED-DEPENDENCIES.txt').write_text(lib[:lib.index('*/')+2] + '\n')
# Upstream stdlib notices are a superset: preserve them because native dependencies
# (including OpenSSL) may be statically linked into the embedded libpython.
name = 'cpython-3.14.8+20261013-aarch64-apple-darwin-pgo+lto-full.tar.zst'
archive = root / '.build' / name
sha = '5806ddb9d95d73796c87e1aeb45bf7ec984d08ae9eb94f9020436052b32ce498'
if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != sha:
    url = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261013/' + name.replace('+', '%2B')
    subprocess.run(['curl', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https', url, '-o', str(archive)], check=True)
if hashlib.sha256(archive.read_bytes()).hexdigest() != sha:
    raise RuntimeError('Python license source checksum mismatch')
source = root / '.build/python-license-source'
source.mkdir(parents=True, exist_ok=True)
subprocess.run(['/usr/bin/tar', '-xf', str(archive), '-C', str(source), 'python/PYTHON.json', 'python/licenses'], check=True)
shutil.copytree(source / 'python/licenses', output / 'cpython-3.14.8', dirs_exist_ok=True)
manifest = json.loads((source / 'python/PYTHON.json').read_text())
(output / 'python-component-licenses.json').write_text(json.dumps({
    'version': manifest['python_version'], 'sourceArchive': name, 'sha256': sha,
    'scope': 'Upstream CPython stdlib/native component license superset; includes optional modules.',
    'extensions': {key: [{'licenses': v.get('licenses'), 'license_paths': v.get('license_paths'), 'public_domain': v.get('license_public_domain')} for v in values]
        for key, values in manifest['build_info']['extensions'].items()}
}, indent=2) + '\n')
(output / 'inventory.json').write_text(json.dumps({'packages': packages,
    'scope': 'Minimal helper inputs and build tools. PyInstaller bootloader is used with its distribution exception; no mutagen/curl_cffi/websockets.'}, indent=2) + '\n')
print('Collected minimal helper, EJS, Python and native component notices.')
