#!/usr/bin/env python3
"""Compile/run the exact generated Swift transfer boundary over real SQLite."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess

CORE = Path(__file__).resolve().parents[2]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bindings', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    attempt = out / ('attempt-' + str(1 + len(list(out.glob('attempt-*')))))
    attempt.mkdir()
    bindings = json.loads(args.bindings.read_text())
    library = CORE / 'target/debug/libeditac_ffi.dylib'
    generated = CORE / 'crates/editac-ffi/generated'
    probe = CORE / 'tests/native/session-transfer-probe/main.swift'
    receipt = {'gate': 'SFA-1.2-V1', 'state': 'FAILED', 'checks': [],
               'qualification': 'Actual generated Swift/NativeSession/SQLite on macOS; no UI, device, performance or archival qualification',
               'providerCalls': 0, 'publication': False}
    def run(name, command):
        log = attempt / (name + '.log')
        with log.open('w') as stream:
            result = subprocess.run(list(map(str, command)), cwd=CORE, stdout=stream,
                                    stderr=subprocess.STDOUT, timeout=240)
        receipt['checks'].append({'id': name, 'command': shlex.join(list(map(str, command))),
                                  'exit': result.returncode, 'log': str(log), 'sha256': digest(log)})
        if result.returncode:
            raise RuntimeError(name + ' failed; see ' + str(log))
        return log
    try:
        counts = bindings['counts']
        if not counts['executed'] or counts['failed'] or counts['skipped']:
            raise RuntimeError('binding qualification incomplete')
        if digest(library) != bindings['library']['sha256']:
            raise RuntimeError('compiled library changed after generation')
        if any(digest(CORE / path) != sha for path, sha in bindings['artifacts'].items()):
            raise RuntimeError('generated artifacts changed after generation')
        receipt['bindingsReceiptSha256'] = digest(args.bindings)
        receipt['library'] = {'path': str(library), 'sha256': digest(library)}
        receipt['generatedArtifacts'] = bindings['artifacts']
        receipt['sources'] = {str(p.relative_to(CORE)): digest(p) for p in [Path(__file__), probe]}
        receipt['toolchain'] = run('swift-version', ['xcrun', 'swiftc', '--version']).read_text().strip()
        binary = attempt / 'transfer-probe'
        run('swift-build', ['xcrun', 'swiftc', '-swift-version', '5', '-Onone', '-I', generated,
                           '-Xcc', '-fmodule-map-file=' + str(generated / 'EditacNativeFFI.modulemap'),
                           '-L', library.parent, '-leditac_ffi', '-Xlinker', '-rpath', '-Xlinker', library.parent,
                           generated / 'EditacNative.swift', probe, '-o', binary])
        receipt['binarySha256'] = digest(binary)
        runtime = run('swift-runtime', [binary, attempt / 'stores'])
        receipt['runtime'] = json.loads(runtime.read_text())
        counts = {key: receipt['runtime'][key] for key in ['executed', 'passed', 'failed', 'skipped']}
        receipt['counts'] = counts
        if counts['executed'] != 8 or counts['passed'] != 8 or counts['failed'] or counts['skipped']:
            raise RuntimeError('incomplete runtime evidence')
        receipt['state'] = 'PASS'
    except Exception as error:
        receipt['error'] = str(error)
    finally:
        (attempt / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'state': receipt['state'], 'counts': receipt.get('counts'), 'receipt': str(attempt / 'receipt.json'), 'error': receipt.get('error')}))
    return int(receipt['state'] != 'PASS')

if __name__ == '__main__':
    raise SystemExit(main())
