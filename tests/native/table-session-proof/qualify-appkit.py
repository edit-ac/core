#!/usr/bin/env python3
"""Compose the unchanged native dispatcher and affected suites on one build.

Keep the canonical receipt, actual fixtures, executed binaries and failed logs.
This owns proof orchestration only; native consumers and assertions are unchanged.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

CORE = Path(__file__).resolve().parents[3]
WORKSPACE = CORE.parent
PROOF = Path(__file__).resolve().parent / 'stb-1.6-20261015'
DIRTY = ['crates/editac-core/examples/fitness-edit-cost.rs',
         'crates/editac-core/src/projection.rs',
         'crates/editac-core/tests/fitness_projection_cache.rs']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    env = {**os.environ, 'PATH': str(Path.home() / '.nvm/versions/node/v24.19.0/bin')
           + ':' + str(Path.home() / '.cargo/bin') + ':' + os.environ['PATH'],
           'RUSTUP_TOOLCHAIN': '1.97.1', 'CARGO_NET_OFFLINE': 'true', 'NSUnbufferedIO': 'YES'}
    report = dict(gate='STB-1.6-b', state='failed', commands=[], providerCalls=0,
                  publication=False, counts={}, coordinatorSha256=sha(Path(__file__)),
                  unrelatedSources={p: sha(CORE / p) for p in DIRTY})

    def save():
        (out / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')

    def run(name, command, extra=None, timeout=600):
        entry = dict(name=name, command=list(map(str, command)), environment=extra or {}, log=name + '.log')
        report['commands'].append(entry)
        save()
        start = time.monotonic()
        with (out / entry['log']).open('w') as stream:
            result = subprocess.run(entry['command'], cwd=CORE, env={**env, **(extra or {})},
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        entry.update(exitCode=result.returncode, seconds=round(time.monotonic()-start, 2),
                     sha256=sha(out / entry['log']))
        save()
        assert result.returncode == 0, name + ': see ' + str(out / entry['log'])
        return (out / entry['log']).read_text()

    try:
        report['sourceCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CORE, text=True).strip()
        envelope = json.loads((PROOF / 'source-envelope.json').read_text())
        for repo in ['core', 'architecture']:
            changed = [p for p, h in envelope[repo].items() if sha(WORKSPACE / repo / p) != h]
            assert not changed, 'prior consumed sources changed: ' + repr(changed)
        artifacts = json.loads((PROOF / 'artifact-envelope.json').read_text())
        changed = [p for p, r in artifacts.items() if sha(PROOF / p) != r['sha256']]
        assert not changed, 'retained artifacts changed: ' + repr(changed)
        report['priorApplicability'] = dict(sourceEnvelopeSha256=sha(PROOF / 'source-envelope.json'),
            artifactEnvelopeSha256=sha(PROOF / 'artifact-envelope.json'),
            checkedSources=sum(len(envelope[r]) for r in ['core', 'architecture']),
            checkedArtifacts=len(artifacts), changedSources=[], changedArtifacts=[])
        spec = importlib.util.spec_from_file_location('native_dispatcher', CORE / 'native/macos/scripts/check.py')
        dispatcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dispatcher)
        text = run('canonical', ['bash', 'native/macos/scripts/check.sh', 'table-editing'], timeout=1200)
        summary = json.loads(text.strip().splitlines()[-1])
        canonical_path = Path(summary['receipt'])
        canonical = json.loads(canonical_path.read_text())
        assert canonical['state'] == 'passed'
        report['canonicalReceipt'] = dict(path=str(canonical_path), sha256=sha(canonical_path))
        shutil.copytree(canonical_path.parent, out / 'canonical')
        report['counts']['tableEditing'] = canonical['counts']
        report['counts'].update(canonical['auxiliaryCounts'])
        report['sourceHashes'] = canonical['sourceHashes']
        report['sharedSourceHashes'] = canonical['sharedSourceHashes']
        report['generatedBindings'] = canonical['generatedBindings']
        cpu = canonical['environment']['cpu']
        triple = {'arm64': 'aarch64-apple-darwin', 'x86_64': 'x86_64-apple-darwin'}[cpu]
        cargo = [str(Path.home() / '.cargo/bin/cargo'), '+1.97.1', 'run']
        flags = ['--locked', '--offline', '--target', triple, '--target-dir', str(CORE / 'target/native-macos-ffi')]
        fixture_env = {}
        for name, factory in [('rich', None), ('style', 'StylesFixture'), ('attachment', 'AttachmentsFixture')]:
            root = out / (name + '-fixture')
            root.mkdir()
            command = cargo + (['-p', 'editac-ffi', '--example', 'session_rich_fixture'] if factory is None
                               else ['--manifest-path', str(CORE / 'native/macos/tests' / factory / 'Cargo.toml')]) + flags
            log = run(name + '-fixture', command, {'EDITAC_NATIVE_SESSION_EVIDENCE': str(root)})
            manifest = Path(log.strip().splitlines()[-1])
            assert manifest.is_file(), str(manifest)
            fixture_env['EDITAC_MACOS_' + name.upper() + '_FIXTURE'] = str(manifest)
            fixture_env['EDITAC_MACOS_' + name.upper() + '_EVIDENCE'] = str(out)
        fixture_env.update(EDITAC_MACOS_TABLE_FIXTURE=canonical['tableFixture']['manifest'],
                           EDITAC_MACOS_TABLE_EVIDENCE=str(out),
                           EDITAC_MACOS_FFI_LIBRARY_DIR=str(Path(canonical['ffiLibraries'][cpu]['path']).parent),
                           SDKROOT=canonical['environment']['sdkPath'], MACOSX_DEPLOYMENT_TARGET='14.0')
        scratch = Path(canonical['scratchPath'])
        command = ['xcrun', 'swift', 'test', '--package-path', str(CORE / 'native/macos'),
                   '--scratch-path', str(scratch / cpu), '--arch', cpu, '--sdk', fixture_env['SDKROOT'],
                   '--skip-build', '--filter',
                   'EditacMacOS(CollaborationLifecycle|AccessibilityText|Durability|Commands|Composition|Edits|Projection|Session|Styles|TableProjection|Attachments|Bootstrap|Toolkit)Tests']
        log = run('affected', command, fixture_env)
        report['counts']['affected'] = dispatcher.xctest_counts(log, 183)
        for counts in report['counts'].values():
            assert counts['executed'] == counts['passed'] > 0 and counts['failed'] == counts['skipped'] == 0
        report['fixtureEnvironment'] = fixture_env
        report['fixtures'] = {key: dict(path=value, sha256=sha(Path(value)),
            files={str(p): sha(p) for p in Path(value).parent.rglob('*') if p.is_file()})
            for key, value in fixture_env.items() if key.endswith('_FIXTURE')}
        # The scratch trees contain the exact Swift test hosts, XCTest binaries and
        # linked objects for both slices. Retain before any subsequent build.
        with tarfile.open(out / 'compiled-runtime.tar.gz', 'w:gz') as archive:
            archive.add(scratch, arcname=scratch.name)
        run('entry-audit', ['python3', 'tests/native/table-session-proof/audit-current-entry.py',
                            '--output', str(out / 'entry-applicability.json')])
        assert report['unrelatedSources'] == {p: sha(CORE / p) for p in DIRTY}
        assert all(sha(CORE / p) == h for p, h in report['sourceHashes'].items()), 'native source changed'
        report['state'] = 'passed'
    except Exception as error:
        report['failure'] = type(error).__name__ + ': ' + str(error)
    finally:
        report['artifacts'] = {str(p.relative_to(out)): dict(sha256=sha(p), bytes=p.stat().st_size)
            for p in out.rglob('*') if p.is_file() and p.name != 'receipt.json'}
        save()
    print(json.dumps({k: report.get(k) for k in ['state', 'counts', 'failure']}), flush=True)
    return int(report['state'] != 'passed')


if __name__ == '__main__':
    raise SystemExit(main())
