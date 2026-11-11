#!/usr/bin/env python3
"""Fetch one pinned PUBLIC npm archive, verify SRI, extract Safe test dependencies.
No npm lifecycle, JS from the package, RPC, wallet, environment secrets or user files.
Dependencies stay in .safe-deps/ and are deliberately NOT bundled in the deliverable.
"""
from pathlib import Path, PurePosixPath
import base64, hashlib, io, json, tarfile, urllib.request
ROOT = Path(__file__).resolve().parent.parent
lock = json.loads((ROOT / 'vendor/SAFE-PACKAGE-LOCK.json').read_text())
URL = 'https://registry.npmjs.org/@safe-global/safe-contracts/-/safe-contracts-1.4.1.tgz'
if lock['resolved'] != URL or lock['version'] != '1.4.1':
    raise SystemExit('Unexpected pinned Safe package')
DEPS = ROOT / '.safe-deps'
if DEPS.is_symlink():
    raise SystemExit('Refusing symlink dependency directory')
DEPS.mkdir(exist_ok=True)
archive = DEPS / 'safe-global-safe-contracts-1.4.1.tgz'
if archive.is_symlink():
    raise SystemExit('Refusing symlink package archive')
if archive.exists():
    data = archive.read_bytes()
else:
    with urllib.request.urlopen(URL, timeout=30) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise SystemExit('Unexpected archive size')
if ('sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()) != lock['integrity']:
    raise SystemExit('Package SRI integrity mismatch; stopping')
if hashlib.sha256(data).hexdigest() != lock['sha256']:
    raise SystemExit('Package SHA256 mismatch; stopping')
if not archive.exists():
    archive.write_bytes(data)
selected = {
    'Safe.sol/Safe.json', 'SafeL2.sol/SafeL2.json',
    'proxies/SafeProxy.sol/SafeProxy.json',
    'proxies/SafeProxyFactory.sol/SafeProxyFactory.json',
    'handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json'
}
checks = []
with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tf:
    for member in tf.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk():
            raise SystemExit('Unsafe package path; stopping')
        if not member.isfile():
            continue
        if not path.parts or path.parts[0] != 'package':
            raise SystemExit('Unexpected package root')
        rel = str(path.relative_to('package'))
        if not (rel.startswith('contracts/') or rel in ['LICENSE', 'README.md', 'package.json']
                or any(rel == 'build/artifacts/contracts/' + item for item in selected)):
            continue
        dest = DEPS / 'safe-contracts' / rel
        for parent in [dest, *dest.parents]:
            if parent == ROOT:
                break
            if parent.is_symlink():
                raise SystemExit('Refusing existing symlink in dependency path')
        raw = tf.extractfile(member).read()
        if dest.exists() and dest.read_bytes() != raw:
            raise SystemExit('Refusing to overwrite a changed dependency file')
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            dest.write_bytes(raw)
        checks.append({'file': str(dest.relative_to(ROOT)),
                       'sha256': hashlib.sha256(raw).hexdigest(), 'unmodified': True})
(ROOT / 'logs').mkdir(exist_ok=True)
(ROOT / 'logs/safe-source-integrity.json').write_text(json.dumps(checks, indent=2) + '\n')
print(f'Official Safe 1.4.1 prepared: {len(checks)} unmodified files; SRI and SHA256 verified; no scripts run.')
