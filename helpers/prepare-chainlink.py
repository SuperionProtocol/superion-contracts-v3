#!/usr/bin/env python3
"""Exact official PUBLIC npm source extraction; never runs package scripts."""
import base64,hashlib,io,json,tarfile,urllib.request
from pathlib import Path,PurePosixPath
root=Path(__file__).resolve().parent.parent
lock=json.loads((root/'vendor/CHAINLINK-PACKAGE-LOCK.json').read_text())
data=urllib.request.urlopen(lock['url'],timeout=60).read()
assert hashlib.sha256(data).hexdigest()==lock['sha256'],'Package SHA256 mismatch'
assert 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()==lock['integrity'],'Package SRI mismatch'
tar=tarfile.open(fileobj=io.BytesIO(data),mode='r:gz')
for rel,h in lock['files'].items():
 p=PurePosixPath(rel);assert not p.is_absolute() and '..' not in p.parts
 member=tar.getmember('package/'+rel);assert member.isfile()
 content=tar.extractfile(member).read();assert hashlib.sha256(content).hexdigest()==h,rel
 dest=root/'.chainlink-deps'/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(content)
print('Chainlink1.5.0 exact official source files verified:',len(lock['files']),'NO official coordinator deployed; test mock is authored locally, with NO proof verification')
