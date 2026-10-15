#!/usr/bin/env python3
"""STB-1.6 current-artifact proof; never admits historical endpoint labels.

Run one phase per fresh evidence directory. Child harnesses own their assertions;
this coordinator preserves commands, full logs, counts and exact consumed inputs.
It deliberately does not issue the final qualified delivery request.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

CORE = Path(__file__).resolve().parents[3]
NODE = Path.home() / '.nvm/versions/node/v24.19.0/bin'
DIRTY = ['crates/editac-core/examples/fitness-edit-cost.rs',
         'crates/editac-core/src/projection.rs',
         'crates/editac-core/tests/fitness_projection_cache.rs']


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['portable', 'native', 'loading'])
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--resume', action='store_true', help='continue failed setup after repair; preserve passing unchanged stages')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=args.resume)
    env = os.environ.copy()
    env.update(PATH=str(NODE) + ':' + str(Path.home() / '.cargo/bin') + ':' + env['PATH'],
               RUSTUP_TOOLCHAIN='1.97.1', CARGO_NET_OFFLINE='true')
    before = {p: digest(CORE / p) for p in DIRTY}
    report = dict(gate='STB-1.6', phase=args.phase, state='FAILED', checks=[],
                  sourceCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CORE, text=True).strip(),
                  unrelatedSources=before, providerCalls=0, publication=False,
                  qualification='Current-artifact prerequisite; full parent/request remains separate')
    paths = subprocess.check_output(['git', 'ls-files'], cwd=CORE, text=True).splitlines()
    report['sourceHashes'] = {p: digest(CORE / p) for p in paths
        if (p.startswith(('crates/', 'packages/', 'fixtures/', 'contracts/', 'scripts/'))
            and '/dist/' not in p and (CORE / p).is_file())}
    report['coordinatorSha256'] = digest(Path(__file__).resolve())
    if args.resume:
        prior = json.loads((out / 'receipt.json').read_text())
        assert prior['state'] == 'FAILED' and prior['phase'] == args.phase
        assert prior['unrelatedSources'] == before
        assert all(digest(CORE / p) == h for p, h in prior['sourceHashes'].items()), 'consumed source changed'
        snapshot = out / ('failed-receipt-' + str(len(list(out.glob('failed-receipt-*'))) + 1) + '.json')
        snapshot.write_text(json.dumps(prior, indent=2) + '\n')
        report['checks'] = prior['checks']
        report['resumedFailure'] = dict(path=str(snapshot), sha256=digest(snapshot))

    def save():
        (out / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')

    def run(name, command, extra=None, kind=None, expected=None):
        previous = next((c for c in report['checks'] if c['id'] == name and c.get('exit') == 0), None)
        if previous:
            assert digest(Path(previous['log'])) == previous['sha256'], name + ': changed passing log'
            assert previous['command'] == list(map(str, command)) and previous['environment'] == (extra or {}), name + ': changed setup'
            print(name, 'reuse unchanged passing stage', flush=True)
            return Path(previous['log'])
        log = out / (name + '.log')
        if log.exists():
            log = out / (name + '-attempt-' + str(2 + len(list(out.glob(name + '-attempt-*.log')))) + '.log')
        start = time.monotonic()
        entry = dict(id=name, command=list(map(str, command)), environment=extra or {}, log=str(log))
        report['checks'].append(entry)
        save()
        with log.open('w') as stream:
            p = subprocess.run(entry['command'], cwd=CORE, env={**env, **(extra or {})},
                               stdout=stream, stderr=subprocess.STDOUT, timeout=600)
        entry.update(exit=p.returncode, seconds=round(time.monotonic()-start, 2), sha256=digest(log))
        text = log.read_text()
        counts = []
        if kind == 'rust':
            counts = [dict(passed=int(a), failed=int(b), skipped=int(c)) for a, b, c in
                      re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', text)]
        elif kind == 'node':
            values = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|skipped|cancelled|todo) (\d+)$', text, re.M)}
            if values:
                counts = [dict(passed=values['pass'], failed=values['fail'],
                               skipped=values['skipped'] + values['cancelled'] + values['todo'])]
        elif kind == 'roundtrip':
            counts = [dict(passed=int(a), failed=int(b), skipped=int(c)) for a, b, c in
                      re.findall(r'roundtrip: (\d+) passed; (\d+) failed; (\d+) skipped', text)]
        if kind:
            entry['counts'] = {k: sum(c[k] for c in counts) for k in ['passed', 'failed', 'skipped']}
            entry['counts']['executed'] = sum(entry['counts'].values())
        if kind == 'rust':
            binaries = out / 'rust-binaries'
            binaries.mkdir(exist_ok=True)
            for path in re.findall(r'Running .*?\((target/[^)]+)\)', text):
                source = CORE / path
                if source.is_file():
                    shutil.copy2(source, binaries / source.name)
        save()
        print(name, p.returncode, entry.get('counts', ''), flush=True)
        assert p.returncode == 0, name + ': ' + str(log)
        if kind:
            assert counts and entry['counts']['passed'] > 0, name + ': zero/missing tests'
            assert not entry['counts']['failed'] and not entry['counts']['skipped'], name + ': incomplete checks'
            if expected is not None:
                assert entry['counts']['passed'] == expected, name + ': unexpected count'
        return log

    try:
        run('node-version', ['node', '--version'])
        assert (out / 'node-version.log').read_text().strip() == 'v24.19.0'
        run('rust-version', ['rustc', '--version'])
        assert (out / 'rust-version.log').read_text().startswith('rustc 1.97.1 ')
        if args.phase == 'portable':
            # Build first; node_modules alone never qualifies consumed artifacts.
            run('wasm-build', ['npm', 'run', 'build:wasm'])
            run('package-build', ['npm', 'run', 'build'])
            runtime = out / 'runtime'
            shutil.copytree(CORE / 'packages/core/dist', runtime)
            report['runtime'] = {str(p.relative_to(out)): digest(p) for p in runtime.rglob('*') if p.is_file()}
            exchange = out / 'exchange'
            exchange.mkdir()
            setup = {'EDITAC_COMPATIBILITY_OUTPUT': str(exchange)}
            base = ['cargo', 'test', '-p', 'editac-ffi', '--test', 'architecture_compatibility', '--locked', '--offline']
            run('rust-outbound', base + ['--', '--skip', 'public_js_checkpoint_returns_to_native_and_public_rust_with_unknown_data'], setup, 'rust', 10)
            run('actual-public-js', ['node', 'tests/native/session-proof/nsr-1.1-20261015/compatibility-roundtrip.mjs'], setup, 'roundtrip', 1)
            run('rust-return', base + ['public_js_checkpoint_returns_to_native_and_public_rust_with_unknown_data'], setup, 'rust', 1)
            run('wasm-commands', ['node', '--test', '--test-reporter=tap', 'tests/table-commands.test.mjs', 'tests/atomic-content-commands.test.mjs'], kind='node', expected=6)
            run('default-size', ['node', 'scripts/check-browser-size.mjs'], {'EDITAC_BROWSER_SIZE_OUTPUT': str(out / 'size')})
        elif args.phase == 'loading':
            # Canonical loading consumes both exact single-page and site receipts.
            # Build optional parser artifacts from source before those consumers.
            run('markdown-build', ['npm', 'run', 'build:wasm:markdown'])
            run('package-build', ['npm', 'run', 'build'])
            for name, flags in [('size', []), ('markdown-size', ['--markdown'])]:
                run(name, ['node', 'scripts/check-browser-size.mjs', *flags],
                    {'EDITAC_BROWSER_SIZE_OUTPUT': str(out / name)})
            run('same-page', ['node', 'scripts/test-browser.mjs', 'shared-resources', '--test-reporter=tap'],
                {'EDITAC_SHARED_RESOURCES_OUTPUT': str(out / 'same-page')})
            run('same-page-collect', ['node', 'scripts/collect-shared-resources.mjs', str(out / 'same-page')])
            run('production-site', ['node', 'scripts/test-browser.mjs', 'shared-site-resources', '--test-reporter=tap'],
                {'EDITAC_SHARED_SITE_RESOURCES_OUTPUT': str(out / 'site')})
            run('consolidate', ['node', 'scripts/collect-shared-resources.mjs', '--consolidate',
                out / 'same-page', out / 'site', out / 'size', out / 'markdown-size', out / 'shared'])
            run('canonical-loading', ['node', 'scripts/check-architecture.mjs', '--suite', 'consumers-loading'],
                {'EDITAC_ARCHITECTURE_OUTPUT': str(out / 'canonical'),
                 'EDITAC_SHARED_RESOURCES_RECEIPT': str(out / 'shared')})
            canonical = json.loads((out / 'canonical/receipt.json').read_text())
            counts = canonical['counts']
            assert canonical['exit'] == 0 and not canonical['errors']
            assert counts['tests'] == counts['pass'] > 0
            assert all(counts[k] == 0 for k in ['fail', 'cancelled', 'skipped', 'todo'])
            report['childCounts'] = {'canonicalLoading': counts}
        else:
            run('rust-native', ['cargo', 'test', '-p', 'editac-ffi', '--locked', '--offline', '--lib',
                '--test', 'native_session', '--test', 'native_session_commands', '--test', 'native_session_command_profiles',
                '--test', 'native_session_projection', '--test', 'native_abi'], kind='rust')
            run('bindings', ['python3', 'tests/native/bounded-bindings.py', '--output', out / 'bindings'])
            (out / 'library').mkdir(exist_ok=True)
            shutil.copy2(CORE / 'target/debug/libeditac_ffi.dylib', out / 'library')
            shutil.copytree(CORE / 'crates/editac-ffi/generated', out / 'generated', dirs_exist_ok=True)
            fixtures = {}
            for name, command in [
                ('rich', ['cargo', 'run', '-p', 'editac-ffi', '--example', 'session_rich_fixture', '--locked', '--offline']),
                ('attachments', ['cargo', 'run', '--manifest-path', 'native/macos/tests/AttachmentsFixture/Cargo.toml', '--locked', '--offline', '--target-dir', CORE / 'target']),
            ]:
                log = run(name + '-fixture', command, {'EDITAC_NATIVE_SESSION_EVIDENCE': str(out / (name + '-fixture'))})
                fixtures[name] = Path(log.read_text().strip().splitlines()[-1])
                assert fixtures[name].is_file()
            swift = out / 'swift'
            swift.mkdir(exist_ok=True)
            writer = out / 'library/session_rich_fixture'
            shutil.copy2(CORE / 'target/debug/examples/session_rich_fixture', writer)
            shutil.copy2(out / 'bindings/bindings-receipt.json', swift)
            run('generated-swift', ['python3', 'tests/native/session-command-proof/run.py', '--output', swift,
                '--rich-fixture', fixtures['rich'], '--attachment-fixture', fixtures['attachments'],
                '--fixture-writer', writer,
                '--table-fixture', CORE / 'tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json',
                '--host-transport', '--authority-fixture', CORE / 'tests/native/table-session-proof/stb-1.5-20261015/native-host-admission'])
            run('backward', ['python3', 'tests/native/session-backward.py', '--output', out / 'backward'])
            for name, path in [('bindings', out / 'bindings/bindings-receipt.json'), ('swift', swift / 'receipt.json'), ('backward', out / 'backward/receipt.json')]:
                child = json.loads(path.read_text())
                c = child['counts'] if 'counts' in child else child['runtime']['counts']
                assert c['executed'] == c['passed'] > 0 and c['failed'] == c['skipped'] == 0, name
                report.setdefault('childCounts', {})[name] = c
        assert before == {p: digest(CORE / p) for p in DIRTY}, 'unrelated source changed'
        report['state'] = 'passed'
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        report['artifacts'] = {str(p.relative_to(out)): dict(sha256=digest(p), bytes=p.stat().st_size)
                               for p in out.rglob('*') if p.is_file() and p.name != 'receipt.json'}
        save()
    print(json.dumps({k: report.get(k) for k in ['state', 'childCounts', 'error']}))
    return int(report['state'] != 'passed')


if __name__ == '__main__':
    raise SystemExit(main())
