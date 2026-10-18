#!/usr/bin/env python3
"""Qualify retained canonical review proof; never execute or infer runtime cases."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

NATIVE = Path(__file__).resolve().parents[1]
CRITERIA = {
    'DSK-1.18-read-only', 'DSK-1.18-profile-labels', 'DSK-1.18-attribution',
    'DSK-1.18-stale', 'DSK-1.18-I1-accessible-navigation',
    'DSK-1.18-I1-shared-contract', 'DSK-1.18-I1-live-isolation', 'DSK-1.18-V1',
}


def verify(workspace, evidence, contract, package):
    checks = []

    def check(name, value):
        checks.append({'id': name, 'passed': bool(value)})

    def pin(relative, expected):
        path = workspace / relative
        check('pin:' + relative, path.is_file() and
              hashlib.sha256(path.read_bytes()).hexdigest() == expected)

    delivery = json.loads((evidence / 'delivery.json').read_text())
    receipt_path = evidence / delivery['receipt']
    receipt = json.loads(receipt_path.read_text())
    log = (receipt_path.parent / 'xctest.log').read_text()
    expected = {suite + '.' + case for suite, data in contract['suites'].items()
                for case in data['cases']}
    check('original-contract', contract['gate'] == 'DSK-1.18' and
          contract['consumerGate'] == 'NRC-1.2' and contract['expectedCases'] == 32)
    check('canonical-command', contract['command'] == 'bash native/macos/scripts/check.sh change-review')
    check('all-required-criteria', len(contract['criteria']) == len(CRITERIA) and
          {c['id'] for c in contract['criteria']} == CRITERIA)
    check('mandatory-32-unique-cases', len(expected) == 32 and
          sum(len(s['cases']) for s in contract['suites'].values()) == 32)
    # Match both passed records and all started records: a repeated/missing case,
    # or an extra failed case, must not hide behind a passing aggregate summary.
    for status in ['started', 'passed']:
        records = re.findall(r"Test Case '-\[([^ ]+) ([^\]]+)\]' " + status, log)
        check('exact-case-records:' + status,
              Counter(suite + '.' + case for suite, case in records) == Counter(expected))
    check('no-failed-or-skipped-records', not re.search(r"Test Case .+ (failed|skipped)", log))
    for suite, data in contract['suites'].items():
        source_cases = re.findall(r'func (test\w+)\(', (workspace / 'core' / data['path']).read_text())
        check('registered-source:' + suite, Counter(source_cases) == Counter(data['cases']))
    for criterion in contract['criteria']:
        check('criterion:' + criterion['id'], bool(criterion['criterion']) and
              bool(criterion['cases']) and set(criterion['cases']) <= expected)
    check('canonical-receipt', receipt['state'] == 'passed' and receipt['suite'] == 'change-review' and
          receipt['reviewScope'] == 'actual-session-sqlite-revision-presenter')
    check('nonzero-mandatory-counts', receipt['counts'] ==
          dict(executed=32, passed=32, failed=0, skipped=0, failureAssertions=0))
    commands = {c['name']: c for c in receipt['commands']}
    for name in ['build-arm64', 'build-x86_64', 'slice-arm64', 'slice-x86_64',
                 'ffi-arm64', 'ffi-x86_64', 'host-smoke', 'portable-model-export', 'xctest']:
        check('command:' + name, name in commands and commands[name]['exitCode'] == 0)
    check('all-command-exits', bool(commands) and all(c['exitCode'] == 0 for c in receipt['commands']))
    check('honest-os-host', receipt['provenance'] == 'macos-os-host' and
          receipt['environment']['cpu'] == 'arm64' and contract['provenance']['x86_64'] == 'build-only')
    check('historical-receipt-unmodified-scope', receipt['originalGateClosed'] is False)
    source_pins = json.loads((evidence / delivery['sourcePins']).read_text())
    for group in ['sourcePins', 'runtimePins']:
        pins = json.loads((evidence / delivery[group]).read_text())
        check('nonempty:' + group, bool(pins))
        for relative, expected_hash in pins.items():
            pin(relative, expected_hash)
    for group in ['sourceHashes', 'sharedSourceHashes', 'generatedBindings', 'sharedReviewSources']:
        check('receipt-coverage:' + group, bool(receipt[group]) and all(
            source_pins.get('core/' + path) == value for path, value in receipt[group].items()))
    # The capability manifest is updated after its source-revision commit and is
    # pinned by the delivery; it must still admit every implementation input.
    profile = json.loads((workspace / 'core/native/macos/capability.json').read_text())
    for item in profile['inputs']:
        pin('core/' + item['path'], item['sha256'])
    for generated, native in [('EditacNative.swift', 'Swift/EditacNative.swift'),
                              ('EditacNativeFFI.h', 'FFI/EditacNativeFFI.h')]:
        check('generated-interface:' + generated,
              (workspace / 'core/crates/editac-ffi/generated' / generated).read_bytes() ==
              (workspace / 'core/native/macos/Bindings' / native).read_bytes())
    package_contract = contract['package']
    check('package-name', package['name'] == package_contract['name'])
    check('library-product', any(p['name'] == package_contract['product'] and
                                p['targets'] == ['EditacMacOS'] for p in package['products']))
    targets = {t['name']: t for t in package['targets']}
    for target in package_contract['targets']:
        check('package-target:' + target, target in targets)
    for target, path in [('EditacMacOSChangeReviewTests', 'tests/ChangeReview'),
                         ('EditacMacOSChangeReviewPresentationTests', 'tests/ChangeReviewPresentation')]:
        check('package-test-path:' + target, targets.get(target, {}).get('path') == path)
    # Read the actual dispatcher AST rather than duplicating its selector logic.
    import ast
    tree = ast.parse((workspace / 'core/native/macos/scripts/check.py').read_text())
    suites = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and
                  any(isinstance(t, ast.Name) and t.id == 'SUITES' for t in n.targets))
    check('canonical-dispatcher-registration', suites['change-review'] == (contract['filter'], 32))
    check('canonical-filter-selects-all-cases', all(re.search(contract['filter'], case) for case in expected))
    failed = sum(not c['passed'] for c in checks)
    return {'counts': dict(executed=len(checks), passed=len(checks)-failed, failed=failed, skipped=0),
            'checks': checks, 'criteria': contract['criteria'],
            'qualification': 'Integrity only; reuses 32 retained actual canonical native cases. No new runtime execution.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=NATIVE.parents[2])
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True, help='xcrun swift package dump-package JSON')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.workspace.resolve(), args.evidence.resolve(),
                    json.loads((NATIVE / 'change-review-contract.json').read_text()),
                    json.loads(args.package.read_text()))
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'counts': result['counts'],
                      'failures': [c['id'] for c in result['checks'] if not c['passed']]}))
    return int(result['counts']['failed'] > 0)


if __name__ == '__main__':
    raise SystemExit(main())
