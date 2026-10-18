"""Reconcile native conversion receipts without rerunning or inflating history.

This is an evidence tool, not a converter or a platform-support advertisement.
All references are local; missing, corrupt, zero-case and skipped proofs fail.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile

AUTHORITY = '45d4e3b686de71a14dcebf5f55a13571da9415c7f0b0bf31e77cb82dd2201aa6'
EPUB = 'consumers-native-epub-import-20261018'
PDF = 'consumers-native-pdf-export-20261018'
MATRIX = 'consumers-native-matrix-20261018'


if not __debug__:
    raise RuntimeError('Evidence authentication requires assertions; disable -O/PYTHONOPTIMIZE.')

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def checked(path, expected):
    assert sha(path) == expected, 'hash mismatch: ' + str(path)
    return dict(path=str(path), sha256=expected, bytes=Path(path).stat().st_size)


def counts(kind, text):
    if kind == 'rust-test':
        rows = re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out', text)
        assert rows, 'missing Rust summary'
        p, f, s = sum(int(r[0]) for r in rows), sum(int(r[1]) for r in rows), sum(int(r[2]) + int(r[3]) for r in rows)
    else:
        assert kind == 'node-test'
        def get(k):
            values = re.findall(r'^# ' + k + r' (\d+)$', text, re.M)
            assert len(values) == 1, 'missing/ambiguous TAP summary: ' + k
            return int(values[0])
        p, f, s = get('pass'), get('fail'), get('skipped') + get('cancelled') + get('todo')
        assert get('tests') == p + f + s
    return dict(passed=p, failed=f, skipped=s, executed=p + f)


def command_group(path, index, expected=None):
    if expected:
        checked(path, expected['receiptSha256'])
    c = read(path)['checks'][index]
    text = Path(c['log']).read_text()
    actual = counts(c['kind'], text)
    assert actual == c['counts'], 'receipt/log counts disagree'
    assert c['exit'] == 0 and not c.get('signal') and actual['passed'] > 0
    assert actual['failed'] == actual['skipped'] == 0, 'failed/skipped proof'
    if expected:
        assert actual == expected['counts']
        assert {k: c[k] for k in ['program', 'args', 'kind']} == expected['command']
        checked(c['log'], expected['logSha256'])
    return dict(receipt=checked(path, sha(path)), checkIndex=index,
                command={k: c[k] for k in ['program', 'args', 'kind']},
                log=checked(c['log'], sha(c['log'])), counts=actual,
                namedCases=re.findall(r'^# Subtest: (.+)$', text, re.M))


def package(directory, core):
    p = read(directory / 'prepared.json')
    archive = checked(p['archive'], p['archiveSha256'])
    current, stale = {}, []
    # Every archived member is independently checked; an authenticated archive
    # hash alone does not establish that recorded source pins describe it.
    with tarfile.open(p['archive']) as tar:
        members = tar.getmembers()
        assert len(members) == len(p['sourcePins'])
        assert len({m.name for m in members}) == len(members)
        for m in members:
            assert m.isfile() and m.name in p['sourcePins']
            data = tar.extractfile(m).read()
            pin = p['sourcePins'][m.name]
            assert len(data) == pin['bytes'] and hashlib.sha256(data).hexdigest() == pin['sha256']
    for name, pin in p['sourcePins'].items():
        checked(Path(p['consumer']) / name, pin['sha256'])
        now = sha(core / name) if (core / name).exists() else None
        current[name] = dict(recorded=pin['sha256'], current=now)
        if now != pin['sha256']:
            stale.append(name)
    bins = {k: checked(v['path'], v['sha256']) for k, v in p['binaries'].items()}
    fixtures = {k: checked(core / k, v) for k, v in p['fixtures'].items()}
    notices = {k: checked(k, v) for k, v in p['noticePins'].items()}
    return dict(prepared=checked(directory/'prepared.json', sha(directory/'prepared.json')),
                archive=archive, sources=current, stale=stale, binaries=bins,
                fixtures=fixtures, dependencyNotices=notices, dependencies=p['dependencies'],
                notices=checked(directory/'THIRD-PARTY-NOTICES.txt', p['noticesSha256']))


METRICS = ['hostCallMs', 'durationMs', 'originalBytes', 'serializedBytes',
           'peakObservedRssBytes', 'peakHostRssBytes', 'peakObservedHostAndWorkerRssBytes',
           'rssSamples', 'maxSampleIntervalMs', 'hardRustHeapBytes']


def measurements(path, profile=None, caller=None):
    d = read(path)
    if 'records' in d:
        records = [r for r in d['records'] if r.get('state') == 'passed'
                   and (profile is None or r['result'].get('profile') == profile)]
        assert len(records) >= 2, 'first/repeat measurements missing'
        values = dict(cold=records[0], warm=records[1])
    else:
        values = {k: d[k] for k in ['cold', 'warm']}
    result = {}
    for label, v in values.items():
        assert v['state'] == 'passed' and v['childExited'] and v['outputAccepted']
        assert all(v[k] > 0 for k in ['hostCallMs', 'durationMs', 'peakObservedRssBytes', 'rssSamples', 'serializedBytes'])
        result[label] = {k: v[k] for k in METRICS if k in v}
        result[label]['runtimeProfile'] = v['result'].get('profile')
        result[label]['artifactBytes'] = len(v['result'].get('artifact', []))
        result[label]['diagnosticCodes'] = sorted({x['code'] for x in v['result'].get('report', {}).get('diagnostics', [])})
        heap = v['result'].get('peakRustHeapBytes')
        if heap is not None:
            assert heap > 0
            result[label]['peakRustHeapBytes'] = heap
    startup = None
    if caller is not None:
        c = read(caller)
        assert c['exit'] == 0 and c['hostEndToEndMs'] > 0
        startup = dict(receipt=checked(caller, sha(caller)), command=c)
    all_calls = []
    if 'records' in d:
        for v in records:
            artifact = bytes(v['result'].get('artifact', []))
            all_calls.append(dict(metrics={k:v[k] for k in METRICS if k in v},
                runtimeProfile=v['result'].get('profile'), artifactBytes=len(artifact),
                artifactSha256=hashlib.sha256(artifact).hexdigest() if artifact else None,
                outputNewline=('crlf' if artifact.endswith(b'\r\n') else 'lf') if artifact else None))
    return dict(receipt=checked(path, sha(path)), measurements=result, allRecordedSuccessfulCalls=all_calls, enclosingCaller=startup,
                scope=d.get('scope', 'First/repeat actual isolated calls recorded in case; OS caches not flushed.'))


def build(core, evidence):
    ep = evidence / EPUB
    app = read(ep / 'receipt-applicability.json')
    assert app['sourceAuthority'] == AUTHORITY
    final_pins = read(ep/'final-source-pins.json')
    for name, pin in final_pins.items():
        checked(core/name, pin if isinstance(pin, str) else pin['sha256'])
    final = package(ep / 'canonical5', core)
    assert not final['stale'], 'latest source package stale'
    older = package(ep / 'canonical3', core)
    assert set(older['stale']) == set(app['changedSinceOriginalCanonical'])
    allowed = {'crates/editac-formats-native/src/epub_import.rs',
               'tests/formats/consumers/native/epub-import-case.py',
               'tests/formats/consumers/native/epub-import-oracle.py',
               'tests/formats/consumers/native/epub-import.test.mjs'}
    assert set(older['stale']) == allowed
    groups = [command_group(ep/g['receipt'], g['checkIndex'], g) for g in app['groups']]
    assert [g['originalCommandIndex'] for g in app['groups']] == list(range(12))
    canonical = read(core/'tests/formats/capabilities.json')['scenarios']['consumers-native-epub-import-text']['commands']
    assert [g['command'] for g in groups] == canonical
    # The sole changed Rust module is cfg(epub-import). First eleven groups
    # never enable that native feature. Their exact executed bins are retained.
    for g in groups[:11]:
        if 'crates/editac-formats-native/Cargo.toml' in g['command']['args']:
            assert not any('epub-import' in arg for arg in g['command']['args'])
    compiled = read(ep/'compiled-inputs.json')
    for name, pin in compiled['pins'].items():
        checked(core/name, pin if isinstance(pin, str) else pin['sha256'])
    rust_bins = {k: checked(v['path'], v['sha256']) for k, v in compiled['executedRustBinaries'].items()}
    pdf = package(evidence/MATRIX/'pdf-current', core)
    assert not pdf['stale']
    fresh_path = evidence/MATRIX/'pdf-current/receipt.json'
    fresh = read(fresh_path)
    assert len(fresh['checks']) == 2
    pdf_compiled = read(evidence/MATRIX/'pdf-current/compiled-inputs.json')
    for name, pin in pdf_compiled['localInputPins'].items():
        checked(core/name, pin)
    for pin in list(pdf_compiled['binaries'].values()) + pdf_compiled['depfiles']:
        checked(pin['path'], pin['sha256'])
    reader = read(evidence/MATRIX/'pdf-current/reader-environment.json')
    assert reader['packages'] == {'pypdf':'6.1.1', 'PyMuPDF':'1.26.5', 'fonttools':'4.60.1', 'typing-extensions':'4.16.0'}
    pdf_groups = [command_group(fresh_path, 0),
                  command_group(evidence/MATRIX/'pdf-current/receipt-runtime.json', 0)]
    locked = read(core/'tests/formats/capabilities.json')['scenarios']['consumers-native-pdf-export']['commands']
    for g, i in zip(pdf_groups, [1, 7]):
        assert g['command'] == locked[i], 'fresh PDF commands differ from canonical'
    profiles = read(core/'fixtures/formats/profiles.json')
    expected = {'docx','pdf','odt','rtf','epub','csv','tsv'}
    assert {p['format'] for p in profiles['profiles']} == expected
    c3, c5 = ep/'canonical3', ep/'canonical5'
    # Per-direction mappings name the actual complete canonical command group;
    # CSV and TSV deliberately share tests, never duplicate the execution total.
    mapping = {
        ('rtf','import'): (2, 'native', c3/'costs.json'),
        ('rtf','export'): (3, 'native', c3/'export-costs.json'),
        ('csv','import'): (4, 'native', c3/'table-csv.json'),
        ('tsv','import'): (4, 'native', c3/'table-tsv.json'),
        ('csv','export'): (5, 'native', c3/'table-export-costs.json'),
        ('tsv','export'): (5, 'native', c3/'table-export-costs.json'),
        ('epub','export'): (6, 'epub-native', c3/'epub-export-costs.json'),
        ('docx','export'): (7, 'docx-native', c3/'docx-export-costs.json'),
        ('odt','export'): (8, 'odt-native', c3/'odt-export-costs.json'),
        ('odt','import'): (9, 'odt-native', c3/'odt-import-costs.json'),
        ('docx','import'): (10, 'docx-import-native', c3/'docx-import-costs.json'),
        ('epub','import'): (11, 'epub-import-native', c5/'epub-import-costs.json'),
    }
    callers = {('rtf','import'):'supported', ('rtf','export'):'export-supported',
        ('csv','import'):'table-csv', ('tsv','import'):'table-tsv',
        ('csv','export'):'table-export-dialects', ('tsv','export'):'table-export-dialects',
        ('epub','export'):'epub-export-supported', ('docx','export'):'docx-export-supported',
        ('odt','export'):'odt-export-supported', ('odt','import'):'odt-import-supported',
        ('docx','import'):'docx-import-supported', ('epub','import'):'epub-import-supported'}
    cells = []
    for profile in profiles['profiles']:
        assert set(profile['directions']) == {'import','export'}
        for direction in profile['directions']:
            fmt = profile['format']
            cell = dict(profile=profile['id'], format=fmt, direction=direction,
                        declaration=profile, compiledTarget='aarch64-apple-darwin; macOS26.4.1',
                        otherTargets={k: 'unclaimed-by-native-proof' for k in profile['targets'] if k != 'native'},
                        platformWiring='unqualified; roadmaps31–36/37',
                        fixturePins={k:v for k,v in final['fixtures'].items()
                            if k.startswith('fixtures/formats/'+('table-text' if fmt in ['csv','tsv'] else fmt)+'/')},
                        requiredBuildFeatures=[] if fmt in ['rtf','csv','tsv'] else [fmt+'-'+direction],
                        proofScope='Actual isolated public native adapter; canonical cases cover semantic oracle, diagnostics/full recovery, cancellation/resource/authority/storage/history boundaries. In-memory storage is not crash durability.')
            if fmt == 'pdf' and direction == 'import':
                cell.update(state='export-only-rejected', proofGroup=2,
                            diagnostics='FORMAT_EXPORT_ONLY before conversion/live mutation; original bytes retained')
            elif fmt == 'pdf':
                cell.update(state='qualified-local-publication-subset', freshProofGroups=[0,1],
                            executable=pdf['binaries']['pdf-native'],
                            costs={k: measurements(evidence/MATRIX/'pdf-current'/('pdf-'+k+'-costs.json'), caller=evidence/MATRIX/'pdf-current'/('pdf-export-'+k+'-command.json')) for k in ['text','rich','structure']})
            else:
                index, binary, cost = mapping[fmt,direction]
                p = final if index == 11 else older
                cell.update(state='qualified-local-semantic-subset', proofGroup=index,
                            executable=p['binaries'][binary], costs=measurements(cost, caller=cost.parent/(callers[fmt,direction]+'-command.json')))
                if fmt in ['csv','tsv'] and direction == 'export':
                    variants = ['edit-ac-'+fmt+'-v1', 'edit-ac-'+fmt+'-spreadsheet-safe-v1']
                    cell['costs'] = {name: measurements(c3/'table-export-case-dialects.json', name, c3/'table-export-dialects-command.json') for name in variants}
                    cell['dialects'] = 'Explicit LF and CRLF; two fresh calls for each exact-data/spreadsheet-safe profile in retained dialect case.'
                if direction == 'import' and fmt in ['docx','odt','epub']:
                    cell.update(state='text-prerequisite-only-media-blocked',
                                blocker='FORMAT_NATIVE_ASSET_ADOPTION_UNAVAILABLE', owner='PRIMARY Session/AssetStore',
                                resume='Safely adopt qualified atomic native original retention/adoption with Session/history/store fencing.')
            cells.append(cell)
    assert len(cells) == 14 and len({(c['profile'],c['direction']) for c in cells}) == 14
    dependencies = []
    for folder in ['consumers-native-odt-import-20261018', 'consumers-native-docx-import-20261018', EPUB]:
        request = evidence/folder/'native-dependency-request.json'
        d = read(request)
        assert d['sourceRoadmapRevision'] == AUTHORITY
        for name, pin in d['pins'].items():
            checked(core/name, pin)
        dependencies.append(dict(request=checked(request, sha(request)), task=d['task'], owner=d['owner'],
            fingerprint=d['fingerprint'], unchangedPins=d['pins'], requiredReturn=d['requiredReturn'],
            unblock=d['unblock'], retry=d['retry']))
    history = [dict(receipt=checked(fresh_path, sha(fresh_path)),
        checks=[dict(counts=c.get('counts'), exit=c.get('exit'), log=c.get('log')) for c in fresh['checks']])]
    for folder in [EPUB, PDF, 'consumers-native-docx-import-20261018']:
        for path in sorted((evidence/folder).glob('canonical*/receipt.json')):
            history.append(dict(receipt=checked(path, sha(path)),
                checks=[dict(counts=c.get('counts'), exit=c.get('exit'), log=c.get('log')) for c in read(path)['checks']]))
    generated = {}
    for directory in [c3, c5, evidence/MATRIX/'pdf-current']:
        generated[str(directory)] = [checked(path, sha(path)) for path in sorted(directory.iterdir())
            if path.is_file() and (path.suffix in ['.docx','.odt','.epub','.pdf','.rtf','.csv','.tsv']
                or ('case-' in path.name and path.suffix == '.json'))]
    total = {k:sum(g['counts'][k] for g in groups + pdf_groups) for k in ['executed','passed','failed','skipped']}
    return dict(schemaVersion=1, task='CNV-1.18-C2-N-MATRIX', sourceAuthority=AUTHORITY,
                coreRevision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=core,text=True).strip(),
                toolPins={name: checked(core/'tests/formats'/name, sha(core/'tests/formats'/name))
                    for name in ['native-support-matrix.py','native-support-matrix.test.py','native-matrix-prepare.py','native-matrix-pdf-proof.mjs','native-matrix-capture.py']},
                historicalReceiptsNotSummed=history, unchangedNativeMediaDependencies=dependencies, generatedFixtureAndOutcomeInventory=generated,
                finalCurrentSourcePinCount=len(final_pins),
                profileFixture=checked(core/'fixtures/formats/profiles.json', sha(core/'fixtures/formats/profiles.json')),
                cells=cells, canonicalGroups=groups, freshPdfCanonicalGroups=pdf_groups,
                uniqueComposedCounts=total, packages=dict(current=final, priorExecuted=older, pdfCurrent=pdf),
                executedRustBinaries=rust_bins, freshPdfCompiledInputs=pdf_compiled, generatedPdfReader=reader,
                applicability=dict(rule=app['exactReuse'], changed=older['stale'],
                    docx='Earlier DOCX six mismatches superseded by exact EPUB canonical3 command10; no old DOCX totals added.',
                    pdf='Fresh current optional PDF build and canonical PDF Rust/runtime commands; unaffected canonical groups reused exactly.'),
                baseline=dict(formats=profiles['baseline']['formats'], state='delegated-existing-contracts; outside new native adapter proof'),
                caveats=['No platform/host Save/crash durability/manual-viewer/whole-process hard memory/performance budget/release qualification.',
                         'Costs include complete isolated conversion; OS caches not flushed. See command receipts for caller startup; source archives/binary/font bytes separately pinned.',
                         'All source/fixture/notice pins retained in packages. Declaration planned-unavailable labels are historical registry contracts, not overridden advertisements.',
                         'CSV/TSV exact-data and spreadsheet-safe output are distinct explicit policies tested by shared table-export canonical group.'],
                remaining=['Full native DOCX/ODT/EPUB media adoption', 'Original CNV-1.18/I1/V1/C2/C2-N and roadmaps31–36/37'],
                historicalEvidence=[dict(path=str(evidence/n/'receipt-applicability.json'), sha256=sha(evidence/n/'receipt-applicability.json')) for n in [EPUB, PDF]])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--core', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build(args.core.resolve(), args.evidence.resolve())
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(dict(cells=len(result['cells']), uniqueComposedCounts=result['uniqueComposedCounts'])))
