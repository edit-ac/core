#!/usr/bin/env python3
"""Pin source-subset applicability; changed families never inherit old passes."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

CORE = Path(__file__).resolve().parents[3]
WORKSPACE = CORE.parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=CORE, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prior = WORKSPACE / 'architecture/evidence/macos/rich-generated-session-20261015/entry-impact.json'
    admitted = json.loads(prior.read_text())
    receipts, families = [], {}
    for record in admitted['reusedOwningReceipts']:
        path = WORKSPACE / record['path']
        actual = sha(path)
        receipts.append({**record, 'retainedHashMatches': actual == record['sha256']})
        assert actual == record['sha256'], str(path)
    for gate, contract in admitted['contracts'].items():
        entries = []
        for path in contract['paths']:
            def tree(revision):
                record = git('ls-tree', revision, '--', path)
                return record.split()[2] if record else None
            base = tree(admitted['baseCoreRevision'])
            current = tree('HEAD')
            changed = git('diff', '--name-only', admitted['baseCoreRevision'], '--', path).splitlines()
            entries.append(dict(path=path, admittedTree=base, consumedTree=current, changedPaths=changed,
                                reuse=('unchanged-source-subset' if base is not None and base == current and not changed
                                       else 'absent-no-proof' if base is None and current is None
                                       else 'fresh-owning-proof-required')))
        families[gate] = entries
    previous = CORE / 'tests/native/table-session-proof/stb-1.5-20261015/source-envelope.json'
    sources = json.loads(previous.read_text())['core']
    changed = [path for path, expected in sources.items() if sha(CORE / path) != expected]
    # Reuse only this explicit previous proof, never all acceptance by one hash.
    applicable = dict(sourceEnvelope=str(previous.relative_to(WORKSPACE)), sha256=sha(previous),
        changedConsumedSources=changed,
        reusableSuites=['coreRust:36', 'sessionRust:3'] if not changed else [],
        receipt='core/tests/native/table-session-proof/stb-1.5-20261015/delivery.json',
        receiptSha256=sha(previous.parent / 'delivery.json'))
    report = dict(state='passed-subset-audit', priorAdmission=str(prior.relative_to(WORKSPACE)),
        priorAdmissionSha256=sha(prior), sourceCommit=git('rev-parse', 'HEAD'),
        retainedOwningReceipts=receipts, sourceFamilies=families, reusedAffectedRust=applicable,
        qualification='Exact retained receipts and source subsets only. Changed 12/07 families are supplemented by current generated/native/WASM proof; this audit does not close AppKit/current-entry acceptance.')
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(retainedReceipts=len(receipts), families=len(families), changedPriorPortSources=len(changed),
                          freshSourcePaths=[e['path'] for es in families.values() for e in es if e['reuse']=='fresh-owning-proof-required'])))


if __name__ == '__main__':
    main()
