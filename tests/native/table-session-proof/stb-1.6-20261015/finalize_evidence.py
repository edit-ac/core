"""Retain exact partial worker proof; never create the qualified final request."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
CORE = ROOT.parents[3]
WORKSPACE = CORE.parent
REVISION = 'd13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526'
SOURCE = WORKSPACE / '.roadmap-runner/shared-native-table-boundary-repair-20261015/.roadmap-runner/roadmap-831829a3ecc0/source-3ccb07692d63.md'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')


assert sha(SOURCE) == REVISION
phases = {name: json.loads((ROOT / name / 'receipt.json').read_text())
          for name in ['native', 'portable', 'loading-repaired']}
assert all(p['state'] == 'passed' for p in phases.values())
native = phases['native']
assert all(sha(CORE / path) == h for path, h in native['unrelatedSources'].items())
prior = json.loads((ROOT.parent / 'stb-1.5-20261015/source-envelope.json').read_text())
assert all(sha(CORE / path) == h for path, h in prior['core'].items())
paths = set(prior['core']) | set(native['sourceHashes'])
paths.update('tests/native/table-session-proof/' + name for name in
             ['qualify-current.py', 'audit-current-abi.py', 'audit-current-entry.py'])
write(ROOT / 'source-envelope.json', dict(
    core={p: sha(CORE / p) for p in sorted(paths)},
    architecture={p: sha(WORKSPACE / 'architecture' / p) for p in prior['architecture']},
    unchangedPreexistingDirtySources=native['unrelatedSources'], sourceRoadmapSha256=REVISION))
# Retain exact executed Rust binaries before another build can replace them.
binary_root = ROOT / 'rust-binaries'
binary_root.mkdir(exist_ok=True)
for log in [ROOT / 'raw-wasm-rust.log', *sorted((ROOT / 'portable').glob('rust-*.log'))]:
    for path in re.findall(r'Running .*?\((target/[^)]+)\)', log.read_text()):
        source = CORE / path
        assert source.is_file(), str(source)
        shutil.copy2(source, binary_root / source.name)
for path in Path('/tmp').glob('stb16-*-driver.log'):
    shutil.copy2(path, ROOT / path.name)
abi = json.loads((ROOT / 'abi-audit.json').read_text())
assert abi['counts']['failed'] == abi['counts']['skipped'] == 0
raw = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',
                 (ROOT / 'raw-wasm-rust.log').read_text())
assert raw == [('37', '0', '0')]
assert 'tests 14' in (ROOT / 'architecture-check.log').read_text()
canonical = json.loads((ROOT / 'loading-repaired/canonical/receipt.json').read_text())
assert canonical['counts'] == dict(tests=31, **{'pass': 31, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0})
counts = dict(nativeRust=128, generatedBindings=77, currentSwiftAndLegacyEngine=147,
              unchangedPriorSession=12, abiAssertions=169, rawWasmRust=37,
              actualRustNodeRustExchange=12, wasmCommands=6, architecture=14,
              canonicalLoading=31)
manifest = {str(p.relative_to(ROOT)): dict(sha256=sha(p), bytes=p.stat().st_size)
            for p in sorted(ROOT.rglob('*')) if p.is_file()
            and p.name not in {'delivery.json', 'artifact-envelope.json'} and '__pycache__' not in p.parts}
write(ROOT / 'artifact-envelope.json', manifest)
write(ROOT / 'delivery.json', dict(id='STB-1.6-prerequisite-20261015',
    status='partial-worker-delivery-sync-required', parent='STB-1.6', parentComplete=False,
    qualifiedChildren=['STB-1.6-a', 'STB-1.6-c'], pendingChildren=['STB-1.6-b', 'STB-1.6-d'],
    sourceRoadmapRevision=REVISION, loadedPromptRevision='2e18a98412c7',
    sourceCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CORE, text=True).strip(),
    architectureCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=WORKSPACE/'architecture', text=True).strip(),
    counts={k: dict(executed=n, passed=n, failed=0, skipped=0) for k, n in counts.items()},
    recordedCurrentSummaryChecks=sum(counts.values()), reusedAffectedRustChecks=39,
    countApplicability='Counts are distinct named summary suites; nested canonical receipts retained separately, not added again. Failed initial phases remain failures, not final passes. Prior core36/Session3 reused only by exact unchanged source envelope.',
    originalNativeAcceptance='DSK1.10 P2c/full, DSK1.11 P2b/full, DSK1.15 native UI/input/selection OPEN',
    pending='Named monitor must safely sync incoming native lifecycle consumer, then current affected AppKit/entry proof and immutable final qualified request. No final STB-1.6-20261015 request issued.',
    providerCalls=0, publication=False, mainIntegrated=False,
    sourceEnvelopeSha256=sha(ROOT/'source-envelope.json'), artifactEnvelopeSha256=sha(ROOT/'artifact-envelope.json')))
print(json.dumps(dict(state='partial-worker-delivery-sync-required', currentSummaryChecks=sum(counts.values()), reusedRust=39)))
