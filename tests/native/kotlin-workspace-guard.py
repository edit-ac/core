#!/usr/bin/env python3
"""Deterministic negative controls for NAT-1.4's integrated workspace guard."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

CORE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('kotlin_fixture', CORE / 'tests/native/kotlin-fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
prior = json.loads((CORE.parent / 'architecture/evidence/native-preparation/nat-1.2-20261013/receipt.json').read_text())
baseline = prior['implementation_commit']
old_manifest, old_lock = [subprocess.check_output(['git', 'show', f'{baseline}:{name}'], cwd=CORE, text=True)
    for name in ['Cargo.toml', 'Cargo.lock']]
manifest, lock = [(CORE / name).read_text() for name in ['Cargo.toml', 'Cargo.lock']]

class WorkspaceGuard(unittest.TestCase):
    def check_delta(self, current_manifest=manifest, current_lock=lock):
        return fixture.workspace_expansion(old_manifest, current_manifest, old_lock, current_lock)

    def test_current_integration_requires_fresh_native_qualification(self):
        result = self.check_delta()
        self.assertTrue(result['requires_native_requalification'])
        self.assertEqual(result['members_added'], ['crates/editac-diff', 'crates/editac-session'])

    def test_reject_runtime_pin_change(self):
        self.assertIn('=0.28.0', manifest)
        with self.assertRaises(RuntimeError):
            self.check_delta(current_manifest=manifest.replace('=0.28.0', '=0.28.1'))

    def test_reject_qualified_locked_checksum_change(self):
        checksum = 'ed5909b6e89a2db4456e54cd5f673791d7eca6732202bbf2a9cc504fe2f9b84a'
        self.assertIn(checksum, lock)
        with self.assertRaises(RuntimeError):
            self.check_delta(current_lock=lock.replace(checksum, '0' * 64))

    def test_reject_new_version_of_qualified_package(self):
        with self.assertRaises(RuntimeError):
            self.check_delta(current_lock=lock + '\n[[package]]\nname = "yrs"\nversion = "0.29.0"\n')

    def test_reject_removing_qualified_workspace_member(self):
        self.assertIn('"crates/editac-ffi", ', manifest)
        with self.assertRaises(RuntimeError):
            self.check_delta(current_manifest=manifest.replace('"crates/editac-ffi", ', ''))

if __name__ == '__main__':
    unittest.main()
