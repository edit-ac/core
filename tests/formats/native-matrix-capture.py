"""Retain actual executed PDF Rust binaries and compiler-reported local inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


if not __debug__:
    raise RuntimeError('Evidence authentication requires assertions; disable -O/PYTHONOPTIMIZE.')

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def capture(core, output):
    p = json.loads((output/'prepared.json').read_text())
    c = json.loads((output/'receipt.json').read_text())['checks'][0]
    assert c['exit'] == 0 and c['counts']['passed'] > 0 and c['counts']['failed'] == c['counts']['skipped'] == 0
    text = Path(c['log']).read_text()
    binaries = re.findall(r'Running tests/[^\n]+ \(([^)]+)\)', text)
    assert len(binaries) == 4, 'expected PDF export/structure/jobs/profiles executed Rust binaries'
    store = output/'executed-rust-binaries'; store.mkdir(exist_ok=True)
    retained = {}
    for binary in binaries:
        source = Path(binary)
        dst = store/source.name
        shutil.copy2(source, dst)
        retained[source.name] = dict(path=str(dst), sha256=sha(dst), bytes=dst.stat().st_size)
    pins = {}
    receipts = []
    roots = [core, Path(p['consumer'])]
    for d in sorted((output/'build-target').glob('*/deps/*.d')):
        used = False
        for token in d.read_text().replace('\\\n',' ').split():
            path = Path(token.rstrip(':'))
            for root in roots:
                try: relative = str(path.relative_to(root))
                except ValueError: continue
                if relative not in p['sourcePins'] or not path.is_file(): continue
                pin = sha(path)
                assert pin == p['sourcePins'][relative]['sha256'], relative
                assert sha(core/relative) == pin, relative
                pins[relative] = pin
                used = True
        if used:
                # Debug/release deps may have equal names; their hashes are kept
            # under separate directory identities rather than overwriting.
            dst = store/d.parent.parent.name/d.name
            dst.parent.mkdir(exist_ok=True)
            shutil.copy2(d, dst)
            receipts.append(dict(path=str(dst), sha256=sha(dst)))
    assert len(pins) > 50, 'incomplete local compiler-input inventory'
    result = dict(schemaVersion=1, sourceScope='All local inputs found in debug/release Cargo depfiles; exact package/lock/fixture/notices audited separately.',
                  binaries=retained, localInputPins=pins, depfiles=receipts)
    (output/'compiled-inputs.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(dict(executedBinaries=len(retained), localInputs=len(pins), depfiles=len(receipts))))


if __name__ == '__main__':
    a=argparse.ArgumentParser()
    a.add_argument('--core', type=Path, required=True)
    a.add_argument('--output', type=Path, required=True)
    args=a.parse_args()
    capture(args.core.resolve(), args.output.resolve())
