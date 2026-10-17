#!/usr/bin/env python3
"""Compose SFR-1.4's existing real-boundary checks; retain every command result.

No providers, fixture recording, publication, or controller operations are used.
The output directory must be new so a failed run cannot overwrite evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

CORE = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--with-pending-deliveries', action='store_true',
                        help='also qualify the pinned incoming slash/RTF/EPUB deliveries')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, CARGO_TARGET_DIR=str(CORE / 'target'), CARGO_NET_OFFLINE='true',
               EDITAC_EDITING_ALL_OUTPUT=str(out / 'browser'),
               EDITAC_INTERACTION_PASTE_OUTPUT=str(out / 'paste'),
               EDITAC_INTERACTION_PASTE_TABLES_OUTPUT=str(out / 'paste-tables'),
               EDITAC_INTERACTION_BREAK_TABLES_OUTPUT=str(out / 'break-tables'),
               EDITAC_SLASH_CONTEXT_OUTPUT=str(out / 'slash-context'),
               EDITAC_HISTORY_EXCHANGE=str(out / 'history-exchange'),
               EDITAC_SERVICE_EVIDENCE=str(out / 'sqlite'))
    commands = []

    def run(name, command):
        if name.startswith('formats-'):
            env['EDITAC_FORMATS_OUTPUT'] = str(out / name)
        log = out / (name + '.log')
        with log.open('w') as stream:
            result = subprocess.run(command, cwd=CORE, env=env,
                                    stdout=stream, stderr=subprocess.STDOUT)
        text = log.read_text()
        counts = None
        if '# tests ' in text:
            counts = {key: sum(map(int, re.findall(r'^# ' + key + r' (\d+)$', text, re.M)))
                      for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}
        elif 'test result:' in text:
            rows = re.findall(r'test result: .*? (\d+) passed; (\d+) failed; (\d+) ignored', text)
            counts = dict(zip(['passed', 'failed', 'skipped'],
                              [sum(int(row[i]) for row in rows) for i in range(3)]))
        commands.append(dict(id=name, command=command, exit=result.returncode,
                             log=log.name, sha256=digest(log), counts=counts))
        (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        print(json.dumps(commands[-1]), flush=True)
        return result.returncode == 0

    for name, command in [
        ('engine-build', ['npm', 'run', 'build:wasm']),
        ('markdown-build', ['npm', 'run', 'build:wasm:markdown']),
        ('packages-build', ['npm', 'run', 'build']),
    ]:
        if not run(name, command):
            return 1
    # Record exact production artifacts before any feature checks.
    paths = [p for package in (CORE / 'packages').iterdir()
             for p in (package / 'dist').rglob('*') if p.is_file()]
    runtime = {str(p.relative_to(CORE)): digest(p) for p in sorted(paths)}
    (out / 'runtime-manifest.json').write_text(json.dumps(runtime, indent=2) + '\n')
    checks = [
        ('paste', ['npm', 'run', 'test:interactions', '--', '--group', 'paste']),
        ('cell', ['node', 'scripts/test-browser.mjs', 'interaction-break-tables']),
        ('portable', ['node', '--test', '--test-reporter=tap', 'tests/extension-formatting.test.mjs',
                      'tests/compound-fragment-order.test.mjs']),
        ('session', ['cargo', '+1.97.1', 'test', '-p', 'editac-session', '--features',
                     'native-store', '--test', 'edit_service', '--locked', '--offline']),
        ('engine', ['cargo', '+1.97.1', 'test', '-p', 'editac-core', '--test', 'opaque_fragments',
                    '--test', 'extension_transfer_deletion', '--test', 'table_cells',
                    '--test', 'history', '--locked', '--offline']),
        ('bindings', ['python3', 'tests/native/bounded-bindings.py', '--output', str(out / 'bindings')]),
        ('swift-transfer', ['python3', 'tests/native/session-transfer.py', '--output',
                            str(out / 'swift-transfer'), '--bindings', str(out / 'bindings' / 'bindings-receipt.json')]),
    ]
    if args.with_pending_deliveries:
        checks += [
            ('slash-context', ['npm', 'run', 'test:browser', '--', 'slash-context']),
            ('formats-rtf-export', ['node', 'tests/formats/run.mjs', 'rtf-export']),
            # The export suite includes the full original importer regressions.
            ('formats-epub-export', ['node', 'tests/formats/run.mjs', 'epub-export']),
        ]
    results = [run(name, command) for name, command in checks]
    receipts = []
    for group in ['paste', 'paste-tables', 'break-tables']:
        for browser in ['chromium', 'firefox', 'webkit']:
            path = out / group / browser / 'receipt.json'
            data = json.loads(path.read_text()) if path.exists() else {}
            cases = data.get('cases', [])
            required = ([f'PST-0{i}' for i in range(1, 8)] if group == 'paste' else
                        ['PST-02-cell-multiline', 'PST-02-cell-line-endings'] if group == 'paste-tables'
                        else ['BRK-08-table-false', 'BRK-08-table-true'])
            if group == 'paste':
                required += ['PST-07-unknown-roundtrip', 'PST-07-break-atom-roundtrip']
            missing = [case for case in required
                       if not any(c.get('passed') and c['name'].startswith(case) for c in cases)]
            passed = bool(cases) and not missing and all(c.get('passed') for c in cases)
            passed = passed and data.get('sourcesUnchanged') is True
            passed = passed and all(data.get('cleanup', {}).get(k) is True
                                    for k in ['browserExited', 'serverClosed', 'consumerRemoved'])
            receipts.append(dict(group=group, browser=browser, passed=passed, missing=missing,
                                 counts=data.get('counts'), profile=data.get('browser'),
                                 cases=[dict(name=c['name'], passed=c['passed'],
                                             caseIds=c.get('caseIds')) for c in cases],
                                 receipt=str(path.relative_to(out)),
                                 sha256=digest(path) if path.exists() else None))
    unchanged = all(p.is_file() and digest(p) == h for name, h in runtime.items()
                    for p in [CORE / name])
    nonzero = all(c['counts'] and (c['counts'].get('tests', c['counts'].get('passed', 0)) > 0)
                  and not any(c['counts'].get(k, 0) for k in ['fail', 'failed', 'skipped', 'cancelled'])
                  for c in commands if c['id'] in ['paste', 'cell', 'portable', 'session', 'engine'])
    summary = dict(commandsPassed=all(results), runtimeUnchanged=unchanged, nonzeroChecks=nonzero,
                   browserChecks=receipts, passed=all(results) and unchanged and nonzero and all(r['passed'] for r in receipts))
    (out / 'qualification.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({k: v for k, v in summary.items() if k != 'browserChecks'}), flush=True)
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
