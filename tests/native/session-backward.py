#!/usr/bin/env python3
"""Run the admitted generated Session consumer against the current native library."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess

CORE = Path(__file__).resolve().parents[2]
BASELINE = 'a3abe6a126d6a2b514574eb264f39b08ef5e8446'
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--reuse-receipt', type=Path)
    args = parser.parse_args()
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env['PATH'] = '/Users/bpstr/.nvm/versions/node/v24.19.0/bin:/Users/bpstr/.cargo/bin:' + env['PATH']
    inputs = {}
    for path in ['crates/editac-ffi/generated/EditacNative.swift', 'crates/editac-ffi/generated/EditacNativeFFI.h', 'crates/editac-ffi/generated/EditacNativeFFI.modulemap', 'tests/native/session-probe/main.swift']:
        target = out / Path(path).name
        target.write_bytes(subprocess.check_output(['git', 'show', BASELINE + ':' + path], cwd=CORE))
        inputs[path] = {'sha256': digest(target), 'commit': BASELINE, 'savedPath': str(target.relative_to(CORE))}
    library = CORE / 'target/debug/libeditac_ffi.dylib'
    binary = out / 'old-session-probe'
    report = {'gate': 'RPR-1.3', 'state': 'FAILED', 'inputs': inputs, 'librarySha256': digest(library), 'checks': [],
              'qualification': 'Actual prior admitted generated Swift/header/modulemap and Session consumer against current library; no substitution by regenerated declarations'}
    def run(name, command):
        log = out / (name + '.log')
        with log.open('w') as stream:
            result = subprocess.run(list(map(str, command)), cwd=CORE, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=180)
        report['checks'].append({'id': name, 'command': shlex.join(list(map(str, command))), 'exit': result.returncode, 'logSha256': digest(log)})
        return result.returncode, log
    try:
        if args.reuse_receipt:
            previous = json.loads(args.reuse_receipt.read_text())
            if {p: x['sha256'] for p, x in previous['inputs'].items()} != {p: x['sha256'] for p, x in inputs.items()}:
                raise RuntimeError('admitted consumer inputs changed')
            original = args.reuse_receipt.resolve().parent / 'old-session-probe'
            if digest(original) != previous['binarySha256'] or previous['checks'][0]['id'] != 'build' or previous['checks'][0]['exit']:
                raise RuntimeError('missing passing admitted consumer build')
            binary.write_bytes(original.read_bytes()); binary.chmod(0o755)
            report['reusedBuildReceiptSha256'] = digest(args.reuse_receipt)
        else:
            code, _ = run('build', ['xcrun', 'swiftc', '-swift-version', '5', '-Onone', '-I', out, '-Xcc', '-fmodule-map-file=' + str(out/'EditacNativeFFI.modulemap'), '-L', library.parent, '-leditac_ffi', '-Xlinker', '-rpath', '-Xlinker', library.parent, out/'EditacNative.swift', out/'main.swift', '-o', binary])
            if code:
                raise RuntimeError('admitted consumer build failed')
        report['binarySha256'] = digest(binary)
        code, log = run('runtime', [binary, out/'stores'])
        report['runtime'] = json.loads(log.read_text())
        if code or report['runtime']['counts'] != {'executed': 12, 'passed': 12, 'failed': 0, 'skipped': 0}:
            raise RuntimeError('admitted consumer runtime failed or incomplete')
        report['state'] = 'passed'
    except Exception as error:
        report['error'] = str(error)
    (out/'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report.get(k) for k in ['state', 'error']}))
    return int(report['state'] != 'passed')
if __name__ == '__main__':
    raise SystemExit(main())
