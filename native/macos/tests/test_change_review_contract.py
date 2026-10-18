"""Prepared proof-admission tests, not native/runtime qualification."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

NATIVE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('review_integrity', NATIVE / 'scripts/verify_change_review.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ProofAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir()
        self.contract = json.loads((NATIVE / 'change-review-contract.json').read_text())
        pins = {}

        def source(path, content):
            file = self.root / 'core' / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
            pins['core/' + path] = hashlib.sha256(file.read_bytes()).hexdigest()

        log = []
        for suite, data in self.contract['suites'].items():
            source(data['path'], '\n'.join('func ' + c + '() {}' for c in data['cases']))
            for case in data['cases']:
                for state in ['started', 'passed']:
                    log.append(f"Test Case '-[{suite} {case}]' {state}")
        source('native/macos/scripts/check.py', 'SUITES = ' + repr({
            'change-review': (self.contract['filter'], 32)}))
        for generated, native in [('EditacNative.swift', 'Swift/EditacNative.swift'),
                                  ('EditacNativeFFI.h', 'FFI/EditacNativeFFI.h')]:
            source('crates/editac-ffi/generated/' + generated, generated)
            source('native/macos/Bindings/' + native, generated)
        source('native/macos/capability.json', json.dumps({'inputs': []}))
        (self.evidence / 'source.json').write_text(json.dumps(pins))
        artifact = self.root / 'runtime.bin'
        artifact.write_bytes(b'prepared binary')
        (self.evidence / 'runtime.json').write_text(json.dumps({
            'runtime.bin': hashlib.sha256(artifact.read_bytes()).hexdigest()}))
        self.log = self.evidence / 'xctest.log'
        self.log.write_text('\n'.join(log))
        self.receipt = dict(state='passed', suite='change-review',
            reviewScope='actual-session-sqlite-revision-presenter',
            counts=dict(executed=32, passed=32, failed=0, skipped=0, failureAssertions=0),
            commands=[dict(name=n, exitCode=0) for n in ['build-arm64', 'build-x86_64',
                'slice-arm64', 'slice-x86_64', 'ffi-arm64', 'ffi-x86_64', 'host-smoke',
                'portable-model-export', 'xctest']], provenance='macos-os-host',
            environment={'cpu': 'arm64'}, originalGateClosed=False)
        for group in ['sourceHashes', 'sharedSourceHashes', 'generatedBindings', 'sharedReviewSources']:
            self.receipt[group] = {p.removeprefix('core/'): h for p, h in pins.items()}
        (self.evidence / 'delivery.json').write_text(json.dumps(dict(
            receipt='receipt.json', sourcePins='source.json', runtimePins='runtime.json')))
        self.package = dict(name='EditacMacOS', products=[dict(name='EditacMacOS', targets=['EditacMacOS'])],
            targets=[{'name': name} for name in self.contract['package']['targets']])
        for target in self.package['targets']:
            if target['name'].endswith('ChangeReviewTests'):
                target['path'] = 'tests/ChangeReview'
            if target['name'].endswith('ChangeReviewPresentationTests'):
                target['path'] = 'tests/ChangeReviewPresentation'

    def result(self):
        (self.evidence / 'receipt.json').write_text(json.dumps(self.receipt))
        return verifier.verify(self.root, self.evidence, self.contract, self.package)

    def test_complete_prepared_proof_is_admitted(self):
        self.assertEqual(self.result()['counts']['failed'], 0)

    def test_missing_duplicate_or_failed_case_is_rejected(self):
        original = self.log.read_text()
        for damaged in [original.split('\n', 1)[1], original + '\n' + original.splitlines()[1],
                        original.replace('passed', 'failed', 1)]:
            with self.subTest(damage=damaged[:65]):
                self.log.write_text(damaged)
                self.assertGreater(self.result()['counts']['failed'], 0)

    def test_zero_skipped_or_failed_counts_are_rejected(self):
        for field, value in [('executed', 0), ('skipped', 1), ('failed', 1)]:
            with self.subTest(field=field):
                counts = copy.deepcopy(self.receipt['counts'])
                self.receipt['counts'][field] = value
                self.assertGreater(self.result()['counts']['failed'], 0)
                self.receipt['counts'] = counts

    def test_prepared_ingress_cannot_promote_actual_boundary(self):
        self.receipt['reviewScope'] = 'prepared-ingress-only'
        self.assertGreater(self.result()['counts']['failed'], 0)

    def test_changed_source_or_binary_is_rejected(self):
        for path in ['runtime.bin', 'core/native/macos/scripts/check.py']:
            file = self.root / path
            original = file.read_bytes()
            file.write_bytes(original + b'\n# drift')
            self.assertGreater(self.result()['counts']['failed'], 0)
            file.write_bytes(original)

    def test_missing_original_criterion_or_package_target_is_rejected(self):
        self.contract['criteria'].pop()
        self.assertGreater(self.result()['counts']['failed'], 0)
        self.contract = json.loads((NATIVE / 'change-review-contract.json').read_text())
        self.package['targets'].pop()
        self.assertGreater(self.result()['counts']['failed'], 0)

    def test_failed_command_is_rejected(self):
        self.receipt['commands'][0]['exitCode'] = 1
        self.assertGreater(self.result()['counts']['failed'], 0)

    def test_unpinned_interface_is_rejected(self):
        self.receipt['generatedBindings']['missing-interface.swift'] = '0' * 64
        self.assertGreater(self.result()['counts']['failed'], 0)


if __name__ == '__main__':
    unittest.main()
