"""Check a source ZIP or a packaged folder, reading the output itself rather than the repo.
Usage: python3 scripts/check-release-output.py /absolute/path/to/Meluli-source.zip
       python3 scripts/check-release-output.py /absolute/path/to/Meluli.app
       python3 scripts/check-release-output.py --release <version> <team id> /absolute/path/to/Meluli.app
A packaged app is also held to its fuses, built CSP and entitlements. --release adds everything a
trusted release needs: the Developer ID signature of every binary, notarization, and the bundle's contents.
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
import tempfile
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
}
# An ad hoc signature has no team identifier, so its own frameworks would fail library validation.
AD_HOC_ENTITLEMENTS = ENTITLEMENTS | {'com.apple.security.cs.disable-library-validation'}
APP_ID = 'io.github.rashi123123.meluli'
MINIMUM_SYSTEM_VERSION = '13.3'
USAGE_DESCRIPTIONS = ('NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSAppleEventsUsageDescription')
REQUIRED_RESOURCES = ('bin/meluli-clipboard', 'bin/meluli-insertion', 'bin/meluli-holdkey', 'bin/meluli-callaudio', 'bin/whispercpp/meluli-asr-worker')
# Model weights download separately, and link import is left out of a public package on legal advice.
FORBIDDEN_RESOURCE = re.compile(r'(^|/)(bin/youtube|yt-dlp|deno)(/|$)|\.(gguf|safetensors|mlmodelc)$|(^|/)ggml-[^/]*\.bin$', re.IGNORECASE)
UPDATE_FEED = b'/releases/latest/download/releases.json'
CPU_ARM64 = 0x0100000c
SYSTEM_LIBRARY = re.compile(r'^(/usr/lib/|/System/Library/|@rpath/|@loader_path/|@executable_path/)')
NOTARIZED = 'source=Notarized Developer ID'
# Electron's and SQLite's own files hold build paths and sample names that are not ours to fix.
THIRD_PARTY = re.compile(r'^Contents/Frameworks/|/node_modules/better-sqlite3/deps/')
# The Apple certificate extension that marks a Developer ID Application leaf.
DEVELOPER_ID_LEAF = 'certificate leaf[field.1.2.840.113635.100.6.1.13]'


def fuses_hold(app):
    binary = (app / 'Contents/Frameworks/Electron Framework.framework/Electron Framework').read_bytes()
    start = binary.index(FUSE_SENTINEL) + len(FUSE_SENTINEL)
    wire = binary[start + 2:start + 2 + binary[start + 1]]
    return all(position < len(wire) and wire[position] == state for position, state in REQUIRED_FUSES.items())


def asar_files(app, *folders):
    """Yields (name, bytes) for each file directly inside a folder of the archive."""
    with (app / 'Contents/Resources/app.asar').open('rb') as archive:
        prefix = archive.read(16)
        header_size, json_size = struct.unpack('<I', prefix[4:8])[0], struct.unpack('<I', prefix[12:16])[0]
        header = json.loads(archive.read(json_size))
        for folder in folders:
            header = header['files'][folder]
        for name, entry in header['files'].items():
            if 'offset' in entry:
                archive.seek(8 + header_size + int(entry['offset']))
                yield name, archive.read(entry['size'])


def built_csp_holds(app):
    html = dict(asar_files(app, 'out', 'renderer'))['index.html']
    directive = re.search(rb'connect-src\s+([^;]*);', html)
    return directive is not None and directive.group(1).strip() == b"'self'"


def signature_details(path):
    return subprocess.run(['codesign', '-d', '--verbose=4', str(path)], capture_output=True, text=True, check=True).stderr


def team_identifier(details):
    match = re.search(r'^TeamIdentifier=(\S+)$', details, re.MULTILINE)
    return None if match is None or match.group(1) == 'not' else match.group(1)


def entitlements_hold(app):
    signed = subprocess.run(['codesign', '-d', '--entitlements', '-', '--xml', str(app)], capture_output=True, check=True)
    expected = ENTITLEMENTS if team_identifier(signature_details(app)) else AD_HOC_ENTITLEMENTS
    return {name for name, value in plistlib.loads(signed.stdout).items() if value} == expected


def packaged_findings(app):
    for label, holds in (('fuse_state', fuses_hold), ('built_csp', built_csp_holds), ('entitlements', entitlements_hold)):
        try:
            passed = holds(app)
        except (OSError, ValueError, KeyError, IndexError, struct.error, plistlib.InvalidFileException, subprocess.SubprocessError):
            passed = False
        if not passed:
            yield app.name, label, 1


def mach_o_cpu_types(path):
    """The architectures in a Mach-O file, or None when the file is something else."""
    with path.open('rb') as binary:
        head = binary.read(8)
        if len(head) < 8:
            return None
        if head[:4] == b'\xcf\xfa\xed\xfe':
            return [struct.unpack('<I', head[4:8])[0]]
        if head[:4] in (b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'):
            count = struct.unpack('>I', head[4:8])[0]
            size = 20 if head[3] == 0xbe else 32
            # A Java class shares the first magic, with its version where a count would be.
            if count > 8:
                return None
            return [struct.unpack('>I', binary.read(size)[:4])[0] for _ in range(count)]
    return None


def mach_o_files(app):
    for current, _dirs, files in os.walk(app, followlinks=False):
        for name in files:
            path = Path(current) / name
            if path.is_symlink():
                continue
            cpu_types = mach_o_cpu_types(path)
            if cpu_types is not None:
                yield path, cpu_types


def linked_libraries(path):
    # otool reads a name ending in ")" as an archive member, and every Electron helper has one.
    with tempfile.TemporaryDirectory() as folder:
        link = Path(folder) / 'binary'
        link.symlink_to(path)
        linked = subprocess.run(['xcrun', 'otool', '-L', str(link)], capture_output=True, text=True, check=True).stdout
    # otool prints the file's own name first, once per architecture.
    return [line.strip().split(' (', 1)[0] for line in linked.splitlines()[1:]]


def binary_findings(path, cpu_types, team):
    if cpu_types != [CPU_ARM64]:
        yield 'not_arm64'
    try:
        details = signature_details(path)
    except subprocess.SubprocessError:
        yield 'unsigned'
        return
    if 'Signature=adhoc' in details:
        yield 'ad_hoc_signature'
    if team_identifier(details) != team:
        yield 'wrong_team'
    if not re.search(r'^Authority=Developer ID Application: ', details, re.MULTILINE):
        yield 'not_developer_id'
    if not re.search(r'^CodeDirectory .*flags=0x[0-9a-f]*\([^)]*\bruntime\b', details, re.MULTILINE):
        yield 'no_hardened_runtime'
    if not re.search(r'^Timestamp=', details, re.MULTILINE):
        yield 'no_secure_timestamp'
    try:
        libraries = linked_libraries(path)
    except subprocess.SubprocessError:
        yield 'unreadable_libraries'
        return
    if any(library and not SYSTEM_LIBRARY.match(library) for library in libraries):
        yield 'external_library'


def info_plist_holds(app, version):
    with (app / 'Contents/Info.plist').open('rb') as source:
        info = plistlib.load(source)
    return (info.get('CFBundleIdentifier') == APP_ID
            and info.get('CFBundleName') == 'Meluli'
            and info.get('CFBundleShortVersionString') == version
            and info.get('CFBundleVersion') == version
            and info.get('LSMinimumSystemVersion') == MINIMUM_SYSTEM_VERSION
            and bool(info.get('ElectronAsarIntegrity'))
            and all(info.get(key) for key in USAGE_DESCRIPTIONS))


def bundle_signature_holds(app):
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], capture_output=True, check=True)
    return True


def designated_requirement_holds(app, team):
    requirement = subprocess.run(['codesign', '-d', '-r-', str(app)], capture_output=True, text=True, check=True).stdout
    # codesign quotes a team identifier that starts with a digit.
    return (f'identifier "{APP_ID}"' in requirement and DEVELOPER_ID_LEAF in requirement
            and re.search(rf'certificate leaf\[subject\.OU\] = "?{team}"?(\s|$)', requirement) is not None)


def gatekeeper_holds(app):
    verdict = subprocess.run(['spctl', '-a', '-vv', '-t', 'exec', str(app)], capture_output=True, text=True, check=True)
    return NOTARIZED in verdict.stderr


def stapled_ticket_holds(app):
    subprocess.run(['xcrun', 'stapler', 'validate', str(app)], capture_output=True, check=True)
    return True


def update_feed_holds(app):
    return any(UPDATE_FEED in payload for _name, payload in asar_files(app, 'out', 'main'))


def release_findings(app, version, team):
    checks = (
        ('info_plist', lambda: info_plist_holds(app, version)),
        ('bundle_signature', lambda: bundle_signature_holds(app)),
        ('designated_requirement', lambda: designated_requirement_holds(app, team)),
        ('gatekeeper', lambda: gatekeeper_holds(app)),
        ('stapled_ticket', lambda: stapled_ticket_holds(app)),
        ('update_feed', lambda: update_feed_holds(app)),
    )
    for label, holds in checks:
        try:
            passed = holds()
        except (OSError, ValueError, KeyError, plistlib.InvalidFileException, subprocess.SubprocessError):
            passed = False
        if not passed:
            yield app.name, label, 1
    resources = app / 'Contents/Resources'
    for name in REQUIRED_RESOURCES:
        if not (resources / name).is_file():
            yield name, 'missing_resource', 1
    for current, _dirs, files in os.walk(resources):
        for name in files:
            relative = (Path(current) / name).relative_to(resources).as_posix()
            if FORBIDDEN_RESOURCE.search(relative):
                yield relative, 'forbidden_resource', 1
    binaries = 0
    for path, cpu_types in mach_o_files(app):
        binaries += 1
        for label in binary_findings(path, cpu_types, team):
            yield path.relative_to(app).as_posix(), label, 1
    if binaries == 0:
        yield app.name, 'no_binaries', 1


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
    arguments = sys.argv[1:]
    release = None
    if arguments[:1] == ['--release']:
        if len(arguments) != 4:
            raise SystemExit('Usage: --release <version> <team id> /absolute/path/to/Meluli.app')
        release = arguments[1:3]
        arguments = arguments[3:]
    if len(arguments) != 1 or not Path(arguments[0]).is_absolute():
        raise SystemExit('Provide an absolute path to a ZIP or a folder.')
    path = Path(arguments[0])
    if release and path.suffix != '.app':
        raise SystemExit('--release takes a packaged app.')
    entries = folder_entries(path) if path.is_dir() else zip_entries(path)
    findings, checked = [], 0
    for name, payload, problem in entries:
        if problem:
            findings.append((name, problem, 1))
            continue
        if release and THIRD_PARTY.search(name):
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
    if release:
        findings.extend(release_findings(path, *release))
    for name, label, count in findings:
        print(f'{label}\t{count}\t{name}')
    print(f'checked {checked} files, {len(findings)} findings')
    sys.exit(1 if findings else 0)


main()
