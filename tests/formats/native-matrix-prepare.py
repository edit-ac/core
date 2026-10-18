"""Refresh only the missing PDF feature over an authenticated native source union.

The existing canonical non-PDF command groups retain their exact executed bytes.
No network, dependency updates, or fabricated source files are used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


if not __debug__:
    raise RuntimeError('Evidence authentication requires assertions; disable -O/PYTHONOPTIMIZE.')

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def prepare(core, evidence, output):
    base = evidence / 'consumers-native-epub-import-20261018/canonical5'
    prior = evidence / 'consumers-native-pdf-export-20261018/canonical7'
    p = json.loads((base / 'prepared.json').read_text())
    old = json.loads((prior / 'prepared.json').read_text())
    assert sha(p['archive']) == p['archiveSha256']
    for name, pin in p['sourcePins'].items():
        assert sha(core / name) == pin['sha256'], name
        assert sha(Path(p['consumer']) / name) == pin['sha256'], name
    for b in p['binaries'].values():
        assert sha(b['path']) == b['sha256']
    output.mkdir(parents=True, exist_ok=True)
    commands = []
    env = dict(os.environ, CARGO_TARGET_DIR=str(output / 'build-target'),
               CARGO_BUILD_JOBS='2', CARGO_INCREMENTAL='0')

    def run(args, name):
        with (output / (name + '.log')).open('wb') as log:
            r = subprocess.run(args, cwd=p['consumer'], env=env, stdout=log, stderr=subprocess.STDOUT)
        commands.append(dict(args=args, cwd=p['consumer'], exit=r.returncode,
                             log=str(output / (name + '.log')),
                             logSha256=sha(output / (name + '.log'))))
        (output / 'prepare-commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        assert r.returncode == 0, name

    # These are the actual current optional publication build commands, including
    # the same separate production/probe builds used by the canonical harness.
    for label, features in [('pdf-native', 'pdf-export'), ('pdf-probe', 'pdf-export,qualification')]:
        run(['cargo', 'build', '--manifest-path', 'crates/editac-formats-native/Cargo.toml',
             '--locked', '--offline', '--release', '--features', features], 'build-' + label)
        dst = output / label
        shutil.copy2(output / 'build-target/release/editac-formats-native', dst)
        p['binaries'][label] = dict(path=str(dst), sha256=sha(dst), bytes=dst.stat().st_size)
    # Authenticate all retained notices before composing the exact locked union.
    for q in [p, old]:
        for name, pin in q['noticePins'].items():
            assert sha(name) == pin, name
    records = {(d['name'], d['version'], d['source']): d for d in old['dependencies']}
    records.update({(d['name'], d['version'], d['source']): d for d in p['dependencies']})
    p['dependencies'] = sorted(records.values(), key=lambda d: (d['name'], d['version']))
    p['noticePins'].update(old['noticePins'])
    # Preserve each complete notice document rather than removing duplicate text.
    notices = b''
    for directory, q in [(base, json.loads((base/'prepared.json').read_text())), (prior, old)]:
        path = directory / 'THIRD-PARTY-NOTICES.txt'
        assert sha(path) == q['noticesSha256']
        notices += path.read_bytes() + b'\n'
    (output / 'THIRD-PARTY-NOTICES.txt').write_bytes(notices)
    p['noticesSha256'] = sha(output / 'THIRD-PARTY-NOTICES.txt')
    p['noticeComposition'] = 'Authenticated latest native/HTML union plus pinned PDF/font notice document; duplicates retained.'
    (output / 'prepared.json').write_text(json.dumps(p, indent=2) + '\n')
    print(json.dumps(dict(sourceMembers=len(p['sourcePins']), binaries=len(p['binaries']),
                          noticePins=len(p['noticePins']), commands=len(commands))))


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--core', type=Path, required=True)
    a.add_argument('--evidence', type=Path, required=True)
    a.add_argument('--output', type=Path, required=True)
    args = a.parse_args()
    prepare(args.core.resolve(), args.evidence.resolve(), args.output.resolve())
