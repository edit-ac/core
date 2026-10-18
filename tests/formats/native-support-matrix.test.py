"""Adversarial evidence-reader checks; no provider or converter calls."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('matrix', Path(__file__).with_name('native-support-matrix.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class EvidenceRejection(unittest.TestCase):
    def test_optimized_python_cannot_bypass_authentication(self):
        r = subprocess.run([sys.executable, '-O', m.__file__], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('disable -O/PYTHONOPTIMIZE', r.stderr)

    def test_changed_bytes_reject(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'source'; p.write_bytes(b'original')
            pin = m.sha(p); p.write_bytes(b'changed')
            with self.assertRaisesRegex(AssertionError, 'hash mismatch'):
                m.checked(p, pin)

    def test_missing_tap_summary_rejects(self):
        with self.assertRaises(AssertionError):
            m.counts('node-test', 'ok 1 - fake success\n')

    def test_ambiguous_tap_summary_rejects(self):
        with self.assertRaises(AssertionError):
            m.counts('node-test', '# pass 1\n# pass 2\n')

    def test_all_rust_summaries_counted(self):
        text = ('test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out\n'
                'test result: FAILED. 1 passed; 2 failed; 1 ignored; 0 measured; 0 filtered out\n')
        self.assertEqual(m.counts('rust-test', text), dict(passed=4, failed=2, skipped=1, executed=6))

    def group(self, text, declared, code=0):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp)/'run.log'; log.write_text(text)
            receipt = Path(tmp)/'receipt.json'
            receipt.write_text(json.dumps(dict(checks=[dict(log=str(log), kind='node-test',
                counts=declared, exit=code, signal=None, program='node', args=['--test','actual.mjs'])])))
            return m.command_group(receipt, 0)

    def tap(self, passed=1, failed=0, skipped=0):
        return f'# tests {passed+failed+skipped}\n# pass {passed}\n# fail {failed}\n# skipped {skipped}\n# cancelled 0\n# todo 0\n'

    def test_fabricated_receipt_counts_reject(self):
        with self.assertRaisesRegex(AssertionError, 'counts disagree'):
            self.group(self.tap(failed=1), dict(passed=2, failed=0, skipped=0, executed=2))

    def test_skipped_case_never_qualifies(self):
        with self.assertRaisesRegex(AssertionError, 'failed/skipped'):
            self.group(self.tap(skipped=1), dict(passed=1, failed=0, skipped=1, executed=1))

    def test_zero_case_never_qualifies(self):
        with self.assertRaises(AssertionError):
            self.group(self.tap(passed=0), dict(passed=0, failed=0, skipped=0, executed=0))

    def test_failed_command_never_qualifies(self):
        with self.assertRaises(AssertionError):
            self.group(self.tap(), dict(passed=1, failed=0, skipped=0, executed=1), 1)

    def test_success_retains_exact_command_and_log(self):
        g = self.group(self.tap(), dict(passed=1, failed=0, skipped=0, executed=1))
        self.assertEqual(g['command']['args'], ['--test','actual.mjs'])
        self.assertEqual(g['counts']['passed'], 1)
        self.assertEqual(len(g['log']['sha256']), 64)


if __name__ == '__main__':
    unittest.main()
