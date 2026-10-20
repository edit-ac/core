#!/usr/bin/env python3
"""Assemble an immutable scoped STB-1.6 request from committed owning proof."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

CORE = Path(__file__).resolve().parents[3]
WORKSPACE = CORE.parent
ROOT = Path(__file__).resolve().parent
REVISION = 'd13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def write(p, data):
    p.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resume', action='store_true', help='resume failed assembly, never replace a delivery')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=args.resume)
    assert not (out / 'delivery.json').exists(), 'immutable delivery already exists'
    prior = ROOT / 'stb-1.6-20261015'
    current = ROOT / 'stb-1.6-b-20261015'
    receipt = json.loads((current / 'receipt.json').read_text())
    assert receipt['state'] == 'passed', 'AppKit proof incomplete'
    for path, value in receipt['artifacts'].items():
        assert sha(current / path) == value['sha256'], path
    original = WORKSPACE / '.roadmap-runner/shared-native-table-boundary-repair-20261015/.roadmap-runner/roadmap-831829a3ecc0/source-3ccb07692d63.md'
    assert sha(original) == REVISION
    # Retain exact executed factory binaries in addition to the compiled Swift
    # archive and both copied Rust dylibs. Cargo logs identify each executable.
    factory_root = out / 'fixture-factories'
    factory_root.mkdir(exist_ok=args.resume)
    logs = [current / 'canonical/table-fixture.log',
            *[current / (name + '-fixture.log') for name in ['rich', 'style', 'attachment']]]
    for log in logs:
        found = re.findall(r'Running `([^`]+)`', log.read_text())
        assert len(found) == 1, str(log)
        executable = Path(found[0])
        if not executable.is_absolute():
            executable = CORE / executable
        assert executable.is_file(), str(executable)
        shutil.copy2(executable, factory_root / executable.name)
    members = {}
    with tarfile.open(current / 'compiled-runtime.tar.gz') as archive:
        for member in archive:
            if member.isfile():
                with archive.extractfile(member) as stream:
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                members[member.name] = dict(sha256=digest.hexdigest(), bytes=member.size)
            elif member.issym():
                members[member.name] = dict(symlink=member.linkname)
    write(out / 'runtime-members.json', members)
    envelopes = {repo: {} for repo in ['core', 'architecture']}
    for repo, entries in json.loads((prior / 'source-envelope.json').read_text()).items():
        if repo not in envelopes:
            continue
        for path, expected in entries.items():
            assert sha(WORKSPACE / repo / path) == expected, path
            envelopes[repo][path] = expected
    artifacts = json.loads((prior / 'artifact-envelope.json').read_text())
    assert all(sha(prior / p) == r['sha256'] for p, r in artifacts.items())
    for path, expected in {**receipt['sourceHashes'], **receipt['sharedSourceHashes'], **receipt['generatedBindings']}.items():
        assert sha(CORE / path) == expected, path
        envelopes['core'][path] = expected
    for path in [Path(__file__), ROOT / 'qualify-appkit.py']:
        envelopes['core'][str(path.relative_to(CORE))] = sha(path)
    envelopes['sourceRoadmapSha256'] = REVISION
    envelopes['unchangedPreexistingDirtySources'] = receipt['unrelatedSources']
    assert all(sha(CORE / p) == h for p, h in receipt['unrelatedSources'].items())
    write(out / 'source-envelope.json', envelopes)
    # Every retained file, including nested receipts, is pinned; archive bytes pin
    # the compiled runtime while canonical fixture receipts retain exact identity.
    write(out / 'artifact-envelope.json', {
        str(p.relative_to(WORKSPACE)): dict(sha256=sha(p), bytes=p.stat().st_size)
        for root in [prior, current, out] for p in sorted(root.rglob('*'))
        if p.is_file() and p.name != 'artifact-envelope.json' and '__pycache__' not in p.parts})
    base = json.loads((prior / 'delivery.json').read_text())
    counts = {**base['counts'], **{'appkit' + k[0].upper() + k[1:]: v for k, v in receipt['counts'].items()}}
    smoke = (current / 'canonical/host-smoke.log').read_text()
    assert 'EDITAC_NATIVE_HOST_SMOKE_PASS' in smoke
    architecture_log = (current / 'architecture-check.log').read_text()
    assert 'tests 14' in architecture_log and 'pass 14' in architecture_log
    assert 'fail 0' in architecture_log and 'skipped 0' in architecture_log
    counts['appkitHostSmoke'] = dict(executed=1, passed=1, failed=0, skipped=0)
    assert all(c['executed'] == c['passed'] > 0 and c['failed'] == c['skipped'] == 0 for c in counts.values())
    ownership = json.loads((WORKSPACE / '.roadmap-coordination/shared-native-table-ownership-20261015.json').read_text())
    commits = {repo: subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=WORKSPACE / repo, text=True).strip()
               for repo in ['core', 'architecture']}
    request = dict(requestId='STB-1.6-20261015', status='qualified-worker-delivery-awaiting-monitor',
        at=datetime.datetime.now(datetime.timezone.utc).isoformat(), parent='STB-1.6', parentComplete=True,
        owner='existing-primary-lane', monitor='monitor-edit-ac-runners-and-merge-progress',
        scope='STB-1.1 through STB-1.6 shared native boundary qualification only; monitor-only STB-1.7 remains open',
        commits=commits, sourceRoadmapRevision=REVISION, loadedPromptRevision='2e18a98412c7',
        sourceEnvelopeSha256=sha(out / 'source-envelope.json'), artifactEnvelopeSha256=sha(out / 'artifact-envelope.json'),
        runtimeMembersSha256=sha(out / 'runtime-members.json'),
        appkitReceipt=dict(path=str((current / 'receipt.json').relative_to(WORKSPACE)), sha256=sha(current / 'receipt.json')),
        priorReceipt=dict(path=str((prior / 'delivery.json').relative_to(WORKSPACE)), sha256=sha(prior / 'delivery.json')),
        entryApplicability=dict(path=str((current / 'entry-applicability.json').relative_to(WORKSPACE)), sha256=sha(current / 'entry-applicability.json')),
        checks=counts, recordedSummaryChecks=sum(c['passed'] for c in counts.values()), reusedAffectedRustChecks=39,
        countApplicability='Named summary suites; nested suites are not added again. 619 prior summary checks and 39 prior Rust checks apply only by exact retained source/artifact identity; 212 fresh native checks and 14 fresh architecture checks. Prepared guards remain explicitly separate from actual Session integration in owning receipts.',
        originalWorkspace=ownership['originalWorkspace'], originalProgress=ownership['originalProgress'],
        originalPendingQueue=ownership['originalPendingQueue'], progress=str(WORKSPACE / '.roadmap-runner/shared-native-table-boundary-repair-20261015/progress.md'),
        originalNativeAcceptance='Original DSK1.10 nativeP2c/full, DSK1.11 nativeP2b/full and DSK1.15 native UI/input/selection stay OPEN for owning lane and monitor; no closure by this request',
        nextGate='STB-1.7', mainIntegrated=False, providerCalls=0, publication=False,
        qualification='Shared-port/current-consumer deterministic package readiness on pinned arm64 macOS host; both CPU slices compile. No physical/full-platform/release/production-security/true-peak/performance claim.')
    write(out / 'delivery.json', request)
    print(json.dumps(dict(status=request['status'], checks=request['recordedSummaryChecks'],
                          reusedRust=39, receipt=str(out / 'delivery.json'))))


if __name__ == '__main__':
    main()
