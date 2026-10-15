"""Count admission regression cases; these are not native-control evidence."""
import importlib.util
from pathlib import Path
import unittest
import subprocess
import sys

spec = importlib.util.spec_from_file_location("dispatcher", Path(__file__).parents[1] / "scripts/check.py")
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)


class CountAdmissionTests(unittest.TestCase):
    def test_real_nonzero_summary(self):
        self.assertEqual(dispatcher.xctest_counts("Executed 1 test, with 0 failures", 1),
                         dict(executed=1, passed=1, failed=0, skipped=0, failureAssertions=0))

    def test_absent_summary(self):
        with self.assertRaises(ValueError):
            dispatcher.xctest_counts("0 tests passed", 1)

    def test_zero_tests(self):
        with self.assertRaises(ValueError):
            dispatcher.xctest_counts("Executed 0 tests, with 0 failures", 1)

    def test_wrong_matching_count(self):
        with self.assertRaises(ValueError):
            dispatcher.xctest_counts("Executed 2 tests, with 0 failures", 1)

    def test_failure(self):
        with self.assertRaises(ValueError):
            dispatcher.xctest_counts("Executed 1 test, with 1 failure", 1)

    def test_skip(self):
        with self.assertRaises(ValueError):
            dispatcher.xctest_counts("Executed 1 test, with 1 test skipped and 0 failures", 1)

    def test_unknown_suite_rejected(self):
        result = subprocess.run([sys.executable, dispatcher.__file__, "unimplemented-suite"], capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"unknown/unimplemented suite", result.stderr)

    def test_missing_suite_rejected(self):
        result = subprocess.run([sys.executable, dispatcher.__file__], capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
