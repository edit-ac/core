#!/usr/bin/env python3
"""Pin exact reused entry/bridge proof and additive generated command signatures."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

CORE = Path(__file__).resolve().parents[3]
WORKSPACE = CORE.parent

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=CORE, text=True).strip()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    checks, pins = [], {}
    def check(name, condition):
        checks.append({'id': name, 'passed': bool(condition)})
    def pin(path):
        path = path.resolve()
        pins[str(path.relative_to(WORKSPACE))] = digest(path)
    previous_path = CORE / '.artifacts/rpr-1.3-20261015/entry-impact.json'
    previous = json.loads(previous_path.read_text())
    pin(previous_path)
    contracts = {}
    for receipt in previous['reusedOwningReceipts']:
        p = WORKSPACE / receipt['path']
        check('unchanged-owning-receipt-' + receipt['gate'], digest(p) == receipt['sha256'])
        pin(p)
    for gate, contract in previous['contracts'].items():
        paths = contract['paths']
        delta = git('diff', '--name-only', previous['baseCoreRevision'], '--', *paths).splitlines()
        tree_pins = {p: {'accepted': x['current'], 'consumed': git('rev-parse', 'HEAD:' + p)} for p, x in contract['treePins'].items()}
        check('exact-accepted-consumer-' + gate, bool(tree_pins) and not delta and all(x['accepted'] == x['consumed'] for x in tree_pins.values()))
        contracts[gate] = {'paths': paths, 'delta': delta, 'treePins': tree_pins}
    commands_path = WORKSPACE / 'architecture/evidence/native-session-commands-20261015/qualified-r3/qualification.json'
    commands = json.loads(commands_path.read_text()); pin(commands_path)
    # The bridge/translator and their entire consumed core/WASM/TS source families
    # have not changed since the admitted NCB-1.1 rebuilt-WASM runtime proof.
    bridge_paths = ['crates/editac-core', 'crates/editac-wasm', 'packages/core', 'fixtures']
    bridge_base = '26596e9777f94ef461875fa620073749bf3d60ae'
    bridge_delta = git('diff', '--name-only', bridge_base, '--', *bridge_paths).splitlines()
    check('unchanged-rebuilt-bridge-consumed-sources', not bridge_delta)
    for p, h in commands['artifactPins'].items():
        check('unchanged-bridge-artifact-' + p, digest(WORKSPACE / p) == h); pin(WORKSPACE / p)
    for name in ['wasm-rust.log', 'wasm-build.log', 'wasm-consumer.log']:
        p = commands_path.parent / name
        check('retained-bridge-proof-' + name, digest(p) == commands['logPins'][name]); pin(p)
    history_path = WORKSPACE / 'architecture/evidence/native-session-commands-20261015/history-r1/qualification.json'
    history = json.loads(history_path.read_text()); pin(history_path)
    for p, h in history['sourcePins'].items():
        check('current-history-source-' + p, digest(WORKSPACE / p) == h); pin(WORKSPACE / p)
    for name, h in history['logPins'].items():
        p = history_path.parent / name
        check('retained-history-proof-' + name, digest(p) == h); pin(p)
    generated = CORE / 'crates/editac-ffi/generated'
    swift = (generated / 'EditacNative.swift').read_text().replace('`', '')
    kotlin = (generated / 'ac/edit/nativebridge/editac_ffi.kt').read_text().replace('`', '')
    for method in ['prepareCommands', 'checkCommands', 'commitCommands', 'cancelCommands', 'commandCatalog', 'historyState']:
        check('generated-command-method-' + method, bool(re.search(r'func\s+' + method + r'\s*\(', swift)) and bool(re.search(r'fun\s+' + method + r'\s*\(', kotlin)))
    for record in ['NativePreparedCommands', 'NativeCommandRoute', 'NativeCommandProfile', 'NativeCommandCatalog', 'NativeSessionHistory']:
        check('generated-additive-record-' + record, 'struct ' + record in swift and 'data class ' + record in kotlin)
    failed = sum(not c['passed'] for c in checks)
    report = {'gate': 'NCB-1.3', 'state': 'passed' if not failed else 'FAILED',
        'qualification': 'Exact reused owning/entry/bridge/history source and artifact applicability; audit only. Fresh generated Swift runtime is separate.',
        'coreRevision': git('rev-parse', 'HEAD'), 'acceptedEntryBaseline': previous['baseCoreRevision'],
        'contracts': contracts, 'bridgeBaseline': bridge_base, 'bridgePaths': bridge_paths, 'bridgeDelta': bridge_delta,
        'reusedBridgeSuites': [s for s in commands['suites'] if 'WASM' in s['suite']],
        'sourceAndEvidencePins': pins, 'checks': checks,
        'counts': {'executed': len(checks), 'passed': len(checks)-failed, 'failed': failed, 'skipped': 0},
        'providerCalls': 0, 'publication': False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'state': report['state'], 'counts': report['counts'], 'failed': [c['id'] for c in checks if not c['passed']]}))
    return int(bool(failed))

if __name__ == '__main__':
    raise SystemExit(main())
