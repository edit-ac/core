#!/usr/bin/env python3
"""Bound NSR source impact to prior owning LQR admission, without broad requalification."""
import hashlib
import json
from pathlib import Path
import subprocess

CORE = Path(__file__).resolve().parents[2]
WORKSPACE = CORE.parent
OUT = CORE / 'tests/native/session-proof/nsr-1.2-20261015'
BASE = 'c4fcd5e2797ffaf5c2997d01de720525e849a928'
LQR = WORKSPACE / 'architecture/evidence/link-upstream-qualification/lqr-1.3-source-impact-v3-20261015/receipt.json'
ADMISSION = Path('/Users/bpstr/Github/edit-ac/.roadmap-coordination/monitor/20261014T235700/actual-main-entry.json')
PREFLIGHT = WORKSPACE / 'architecture/evidence/macos/session-preflight-20261015/audit.json'
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*args):
    return subprocess.check_output(['git', *args], cwd=CORE, text=True).strip()

def main():
    checks = []
    def check(name, result):
        checks.append({'id': name, 'passed': bool(result)})
    admission = json.loads(ADMISSION.read_text())
    lqr = json.loads(LQR.read_text())
    preflight = json.loads(PREFLIGHT.read_text())
    rust_path = OUT.parent / 'nsr-1.1-20261015/receipt.json'
    rust = json.loads(rust_path.read_text())
    swift_path = OUT / 'receipt.json'
    swift = json.loads(swift_path.read_text())
    check('lqr-qualified-actual-main-not-prepared-only', admission['actualMainEntryQualified'] is True and admission['state'] == 'qualified-actual-main-entry')
    check('lqr-admitted-supplement-exact', admission['supplementSha256'] == digest(LQR))
    check('lqr-admission-ancestor-of-repair-base', subprocess.run(['git', 'merge-base', '--is-ancestor', admission['repositories']['core']['head'], BASE], cwd=CORE).returncode == 0)
    check('lqr-public-and-entry-nonzero-zero-skip', all(admission[k]['executed'] > 0 and admission[k]['executed'] == admission[k]['passed'] and admission[k]['failed'] == 0 and admission[k]['skipped'] == 0 for k in ['publicVerifier', 'entryControls']))
    historical = []
    for r in preflight['receiptAudits']:
        p = WORKSPACE / r['path']
        check('owning-receipt-unchanged-' + r['gate'], digest(p) == r['sha256'])
        historical.append({'gate': r['gate'], 'path': r['path'], 'sha256': r['sha256']})
    check('rust-owned-source-proof-still-exact', all(digest(CORE / p) == h for p, h in rust['sourceSha256'].items()))
    check('rust-proof-nonzero-zero-fail-skip', all(rust['finalUniqueRust'][k] == v for k, v in {'executed': 45, 'passed': 45, 'failed': 0, 'skipped': 0}.items()))
    check('swift-source-artifact-proof-still-exact', all(digest(CORE / p) == h for p, h in {**swift['sourceHashes'], **swift['generatedArtifacts']}.items()))
    check('swift-actual-runtime-complete', swift['counts']['executed'] == 33 and swift['counts']['passed'] == 33 and not swift['counts']['failed'] and not swift['counts']['skipped'])
    # Delta from the monitor's integrated baseline, not stale historical pins.
    # Existing independent main changes remain with their owning proofs/monitor.
    contracts = {
        '12': {'paths': ['crates/editac-session', 'crates/editac-core', 'crates/editac-wasm/src', 'packages/web/src/session', 'packages/web/src/sync'],
            'consumed': 'Session/NativeStore ports, durable history/recovery/revision; existing browser adapter',
            'impact': 'Additive native consumer enables existing native-store feature. Real Rust SQLite ownership/fault/public-JS compatibility proof in NSR-1.1 plus actual Swift Session proof qualify this changed consumer; Session/store internals unchanged.'},
        '07': {'paths': ['crates/editac-core', 'packages/web/src/modules'],
            'consumed': 'registry, module identity/schema and web module integration',
            'impact': 'No registration, schema, module runtime or web export changes. Existing LQR owning admission reused; legacy Swift engine probe confirms original boundary still executes.'},
        '13': {'paths': ['crates/editac-diff', 'crates/editac-markdown', 'packages/web/src/source'],
            'consumed': 'source reconciliation, history and diff semantics behind EditService',
            'impact': 'No diff/Markdown/source-family implementation or public WASM change. Existing owning admission reused; shared Session edit/history tests exercise the new native consumer without replacing original diff/source acceptance.'},
        '21': {'paths': ['packages/web/src/extensions', 'packages/web/src/modules', 'packages/web/src/index.ts', 'fixtures/extensions'],
            'consumed': 'extension library exports, capability controls and prepared consumer contract',
            'impact': 'No package/export/capability/extension browser changes. Additive native types do not enter the packed web library; current LQR supplement and unchanged original receipts reused.'}}
    for gate, item in contracts.items():
        item['delta'] = git('diff', '--name-only', BASE, '--', *item['paths']).splitlines()
        item['baseTreePins'] = {p: git('rev-parse', BASE + ':' + p) for p in item['paths'] if subprocess.run(['git','cat-file','-e', BASE + ':' + p], cwd=CORE, stderr=subprocess.DEVNULL).returncode == 0}
        check('unchanged-consumed-implementation-' + gate, not item['delta'])
    changed = git('diff', '--name-only', BASE).splitlines()
    allowed = ['Cargo.lock', 'crates/editac-ffi/Cargo.toml', 'crates/editac-ffi/src/lib.rs', 'crates/editac-ffi/src/session.rs', 'crates/editac-ffi/tests/native_session.rs']
    allowed_prefixes = ['crates/editac-ffi/generated/', 'tests/native/']
    check('changed-paths-within-delegation', all(p in allowed or any(p.startswith(a) for a in allowed_prefixes) for p in changed))
    failed = sum(not c['passed'] for c in checks)
    report = {'gate': 'NSR-1.2', 'state': 'qualified-bounded-native-consumer-impact' if not failed else 'FAILED',
        'scope': 'Changed NSR paths only. Historical LQR actual-main admission remains historical; NSR-1.3 monitor owns new main merge/synchronization/entry revalidation. No new broad current-main or AppKit qualification claim.',
        'baseCoreRevision': BASE, 'reviewedCoreRevision': git('rev-parse', 'HEAD'),
        'lqrAdmission': {'path': str(ADMISSION), 'sha256': digest(ADMISSION)},
        'lqrSupplement': {'path': str(LQR.relative_to(WORKSPACE)), 'sha256': digest(LQR), 'state': lqr['state']},
        'preflightSha256': digest(PREFLIGHT), 'owningReceipts': historical,
        'contracts': contracts, 'changedTrackedPaths': changed,
        'newQualification': {'rustReceiptSha256': digest(rust_path), 'swiftReceiptSha256': digest(swift_path)},
        'checks': checks, 'counts': {'executed': len(checks), 'passed': len(checks)-failed, 'failed': failed, 'skipped': 0},
        'notRerun': 'Unchanged upstream browser/source/module/library suites; refreshed only actual native consumer/bindings. This audit is a deterministic hash/applicability check, not runtime cases.',
        'providerCalls': 0, 'publication': False}
    (OUT / 'entry-impact.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'state': report['state'], 'counts': report['counts'], 'failures': [c['id'] for c in checks if not c['passed']]}))
    return int(bool(failed))

if __name__ == '__main__':
    raise SystemExit(main())
