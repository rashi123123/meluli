"""Check a source ZIP or a packaged folder, reading the output itself rather than the repo.
Usage: python3 scripts/check-release-output.py /absolute/path/to/Meluli-source.zip
       python3 scripts/check-release-output.py /absolute/path/to/Meluli.app
A packaged app is also held to its fuses, built CSP and entitlements.
Prints paths, finding types and counts only, never the matched values. Exits 1 on any finding.
"""
import collections
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import struct
import subprocess
import sys
import zipfile

ALLOWED_TOP_LEVEL = {
    '.github', '.gitignore', '.npmrc', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'README.en.md', 'README.md',
    'SECURITY.md', 'SOURCE-MANIFEST.json', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md', 'benchmarks', 'build', 'components.json', 'docs',
    'electron-builder.yml', 'electron.vite.config.ts', 'eslint.config.mjs', 'native', 'package.json',
    'playwright.config.ts', 'pnpm-lock.yaml', 'resources', 'scripts', 'src', 'tests', 'tsconfig.json',
    'tsconfig.node.json', 'tsconfig.web.json', 'vitest.config.ts',
}
FORBIDDEN_NAME = re.compile(
    r'(^|/)(\.git|\.env(\.|$)|\.DS_Store|design-demo|benchmarks/(v\d+|final|fix-paste))(/|$)'
    r'|\.(pem|key|p12|mobileprovision|sqlite|sqlite3|db|wav|m4a|bin|gguf)$',
    re.IGNORECASE)
CONTENT = {
    'home_path': re.compile(rb'/Users/(?!Shared/|runner/|example/|you/)[A-Za-z0-9._-]+'),
    'volume_path': re.compile(rb'/Volumes/(?!Meluli(?:[ /]|$))[A-Za-z0-9]'),
    'private_key': re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    'token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b'),
}
FUSE_SENTINEL = b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
# Positions on Electron's fuse wire, with the states electron-builder.yml sets.
REQUIRED_FUSES = {0: ord('0'), 2: ord('0'), 3: ord('0'), 4: ord('1'), 5: ord('1')}
ENTITLEMENTS = {
    'com.apple.security.device.audio-input',
    'com.apple.security.automation.apple-events',
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation',
}


def fuses_hold(app):
    binary = (app / 'Contents/Frameworks/Electron Framework.framework/Electron Framework').read_bytes()
    start = binary.index(FUSE_SENTINEL) + len(FUSE_SENTINEL)
    wire = binary[start + 2:start + 2 + binary[start + 1]]
    return all(position < len(wire) and wire[position] == state for position, state in REQUIRED_FUSES.items())


def built_csp_holds(app):
    with (app / 'Contents/Resources/app.asar').open('rb') as archive:
        prefix = archive.read(16)
        header_size, json_size = struct.unpack('<I', prefix[4:8])[0], struct.unpack('<I', prefix[12:16])[0]
        header = json.loads(archive.read(json_size))
        entry = header['files']['out']['files']['renderer']['files']['index.html']
        archive.seek(8 + header_size + int(entry['offset']))
        html = archive.read(entry['size'])
    directive = re.search(rb'connect-src\s+([^;]*);', html)
    return directive is not None and directive.group(1).strip() == b"'self'"


def entitlements_hold(app):
    signed = subprocess.run(['codesign', '-d', '--entitlements', '-', '--xml', str(app)], capture_output=True, check=True)
    return {name for name, value in plistlib.loads(signed.stdout).items() if value} == ENTITLEMENTS


def packaged_findings(app):
    for label, holds in (('fuse_state', fuses_hold), ('built_csp', built_csp_holds), ('entitlements', entitlements_hold)):
        try:
            passed = holds(app)
        except (OSError, ValueError, KeyError, IndexError, struct.error, plistlib.InvalidFileException, subprocess.SubprocessError):
            passed = False
        if not passed:
            yield app.name, label, 1


def zip_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        for name, count in collections.Counter(names).items():
            if count > 1:
                yield name, None, 'duplicate_name'
        prefix = names[0].split('/', 1)[0] + '/'
        for name in names:
            if name.endswith('/'):
                continue
            if not name.startswith(prefix):
                yield name, None, 'outside_prefix'
                continue
            relative = name[len(prefix):]
            if PurePosixPath(relative).parts[0] not in ALLOWED_TOP_LEVEL:
                yield relative, None, 'not_allowed'
            yield relative, archive.read(name), None


def folder_entries(path):
    for current, _dirs, files in os.walk(path, followlinks=False):
        for name in files:
            source = Path(current) / name
            relative = source.relative_to(path).as_posix()
            yield relative, None if source.is_symlink() else source.read_bytes(), None


def main():
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        raise SystemExit('Provide an absolute path to a ZIP or a folder.')
    path = Path(sys.argv[1])
    entries = folder_entries(path) if path.is_dir() else zip_entries(path)
    findings, checked = [], 0
    for name, payload, problem in entries:
        if problem:
            findings.append((name, problem, 1))
            continue
        checked += 1
        if FORBIDDEN_NAME.search(name):
            findings.append((name, 'forbidden_name', 1))
        for label, pattern in CONTENT.items():
            count = len(pattern.findall(payload or b''))
            if count:
                findings.append((name, label, count))
    if path.suffix == '.app':
        findings.extend(packaged_findings(path))
    for name, label, count in findings:
        print(f'{label}\t{count}\t{name}')
    print(f'checked {checked} files, {len(findings)} findings')
    sys.exit(1 if findings else 0)


main()
