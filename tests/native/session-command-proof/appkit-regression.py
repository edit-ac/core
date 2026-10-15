#!/usr/bin/env python3
"""Reuse one canonical macOS build for affected unchanged consumer regressions."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

CORE = Path(__file__).resolve().parents[3]
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--admission', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    admission = json.loads(args.admission.read_text())
    assert admission['state'] == 'passed' and admission['suite'] == 'projection'
    assert admission['counts']['executed'] == admission['counts']['passed'] == 22
    for key in ['sourceHashes', 'sharedSourceHashes', 'generatedBindings']:
        for path, expected in admission[key].items():
            assert digest(CORE / path) == expected, 'consumed source changed: ' + path
    for library in admission['ffiLibraries'].values():
        assert digest(Path(library['path'])) == library['sha256']
    spec = importlib.util.spec_from_file_location('canonical', CORE / 'native/macos/scripts/check.py')
    canonical = importlib.util.module_from_spec(spec); spec.loader.exec_module(canonical)
    cpu = admission['environment']['cpu']; scratch = Path(admission['scratchPath'])
    env = os.environ.copy()
    env['PATH'] = '/Users/bpstr/.nvm/versions/node/v24.19.0/bin:/Users/bpstr/.cargo/bin:' + env['PATH']
    env['SDKROOT'] = admission['environment']['sdkPath']
    env['EDITAC_MACOS_FFI_LIBRARY_DIR'] = str(Path(admission['ffiLibraries'][cpu]['path']).parent)
    env['EDITAC_MACOS_RICH_FIXTURE'] = admission['richFixture']['manifest']
    checks = []
    binaries = {str(p): digest(p) for p in scratch.rglob('*') if p.is_file() and (p.name == 'EditacMacOSTestHost' or '.xctest/' in str(p))}
    report = {'gate': 'NCB-1.3', 'state': 'FAILED', 'admission': str(args.admission.resolve()),
        'admissionSha256': digest(args.admission), 'checks': checks, 'runtimeArtifactPins': binaries,
        'provenance': 'Actual macOS arm64 AppKit XCTest; both CPU slices built by canonical admission; x86_64 runtime unexecuted',
        'providerCalls': 0, 'publication': False}
    try:
        assert binaries, 'missing actual runtime artifacts'
        for suite in ['session', 'edits', 'composition', 'commands']:
            name, expected = canonical.SUITES[suite]
            command = ['xcrun', 'swift', 'test', '--package-path', str(CORE / 'native/macos'), '--scratch-path', str(scratch / cpu), '--arch', cpu, '--sdk', env['SDKROOT'], '--skip-build', '--filter', name]
            log = out / (suite + '.log')
            with log.open('w') as stream:
                p = subprocess.run(command, cwd=CORE / 'native/macos', env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=180)
            entry = {'suite': suite, 'command': command, 'exit': p.returncode, 'log': str(log), 'sha256': digest(log)}
            checks.append(entry)
            entry['counts'] = canonical.xctest_counts(log.read_text(), expected)
            assert p.returncode == 0, suite + ' runtime failed'
        report['counts'] = {k: sum(c['counts'][k] for c in checks) for k in ['executed', 'passed', 'failed', 'skipped']}
        report['state'] = 'passed'
    except Exception as error:
        report['error'] = str(error)
    (out / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report.get(k) for k in ['state', 'counts', 'error']}))
    return int(report['state'] != 'passed')

if __name__ == '__main__':
    raise SystemExit(main())
