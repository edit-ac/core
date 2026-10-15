#!/usr/bin/env python3
"""Bound the rich Session repair to admitted consumers; never grant ownership."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

CORE = Path(__file__).resolve().parents[2]
WORKSPACE = CORE.parent
BASE = '9b060f3eae7127d2761d4a80af20299e7213a2f4'
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*args):
    return subprocess.check_output(['git', *args], cwd=CORE, text=True).strip()
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    checks = []
    def check(name, result):
        checks.append({'id': name, 'passed': bool(result)})
    prior = CORE / 'tests/native/session-proof/nsr-1.2-20261015/entry-impact.json'
    admission = json.loads(prior.read_text())
    reused = admission['owningReceipts']
    for receipt in reused:
        check('unchanged-owning-proof-' + receipt['gate'], digest(WORKSPACE / receipt['path']) == receipt['sha256'])
    unchanged = {
        '12': ['packages/web/src/session', 'packages/web/src/sync', 'crates/editac-session/src/store', 'crates/editac-session/src/ports', 'crates/editac-session/src/edit_service.rs', 'crates/editac-session/src/revision.rs'],
        '07': ['crates/editac-core/src/modules', 'packages/web/src/modules'],
        '13': ['crates/editac-diff', 'crates/editac-markdown', 'packages/web/src/source', 'crates/editac-session/src/history_store.rs'],
        '21': ['packages/web/src/extensions', 'packages/web/src/modules', 'packages/web/src/index.ts', 'fixtures/extensions']}
    contracts = {}
    for gate, paths in unchanged.items():
        changes = git('diff', '--name-only', BASE, '--', *paths).splitlines()
        # Only paths existing in the baseline can establish tree equivalence.
        pins = {}
        for path in paths:
            if subprocess.run(['git', 'cat-file', '-e', BASE + ':' + path], cwd=CORE, stderr=subprocess.DEVNULL).returncode == 0:
                pins[path] = {'base': git('rev-parse', BASE + ':' + path), 'current': git('rev-parse', 'HEAD:' + path)}
        check('unchanged-admitted-consumer-' + gate, bool(pins) and not changes and all(p['base'] == p['current'] for p in pins.values()))
        contracts[gate] = {'paths': paths, 'delta': changes, 'treePins': pins}
    shared = git('diff', '--name-only', BASE, '--', 'crates/editac-core', 'crates/editac-session', 'crates/editac-wasm').splitlines()
    check('shared-delta-exactly-reviewed-adapters-and-named-exception', set(shared) == {'crates/editac-core/src/interchange.rs', 'crates/editac-session/src/session.rs', 'crates/editac-wasm/src/bridge.rs'})
    generated = CORE / 'crates/editac-ffi/generated'
    swift = (generated / 'EditacNative.swift').read_text().replace('`', '')
    kotlin = (generated / 'ac/edit/nativebridge/editac_ffi.kt').read_text().replace('`', '')
    swift_session = swift.split('public protocol NativeSessionProtocol', 1)[1].split('open class NativeSession', 1)[0]
    kotlin_session = kotlin.split('public interface NativeSessionInterface', 1)[1].split('open class NativeSession', 1)[0]
    for method in ['richSnapshot', 'takeRichPatches', 'captureAnchors', 'resolveAnchor', 'releaseAnchor']:
        check('one-session-generated-method-' + method, bool(re.search(r'func\s+' + method + r'\s*\(', swift_session)) and bool(re.search(r'fun\s+' + method + r'\s*\(', kotlin_session)))
    for record in ['NativeSessionProjection', 'NativeSessionPatches', 'NativeSessionAnchor', 'NativeSessionAnchorRead']:
        check('owned-generated-record-' + record, 'struct ' + record in swift and 'data class ' + record in kotlin)
    for error in ['ProjectionResyncRequired', 'InvalidProjectionCursor', 'AnchorTarget', 'InvalidAnchor']:
        check('typed-generated-error-' + error, error in swift and error in kotlin)
    failed = sum(not c['passed'] for c in checks)
    report = {'gate': 'RPR-1.3', 'state': 'verified-bounded-impact-awaiting-scope-disposition' if not failed else 'FAILED',
        'baseCoreRevision': BASE, 'reviewedCoreRevision': git('rev-parse', 'HEAD'),
        'priorAdmittedImpact': {'path': str(prior.relative_to(CORE)), 'sha256': digest(prior)},
        'reusedOwningReceipts': reused, 'contracts': contracts, 'sharedDelta': shared,
        'scopeDisposition': {'owner': 'monitor-edit-ac-runners-and-merge-progress', 'state': 'pending', 'commit': '78e2a88', 'path': 'core/crates/editac-wasm/src/bridge.rs', 'workerMayGrantOwnership': False},
        'checks': checks, 'counts': {'executed': len(checks), 'passed': len(checks)-failed, 'failed': failed, 'skipped': 0},
        'qualification': 'Hash/signature/impact guards only, not runtime or ownership admission. Fresh affected native/generated, canonical Session/projection and narrow WASM adapter proof supplied separately. Unchanged admitted12/07/13/21 browser/module/source/library suites reused.',
        'providerCalls': 0, 'publication': False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'state': report['state'], 'counts': report['counts'], 'failed': [c['id'] for c in checks if not c['passed']]}))
    return int(bool(failed))
if __name__ == '__main__':
    raise SystemExit(main())
