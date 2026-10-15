#!/usr/bin/env python3
"""Compare original and pre-atomic public records, tags and generated ABI."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

CORE = Path(__file__).resolve().parents[3]


def declarations(source):
    found = {}
    for match in re.finditer(r'pub (?:struct|enum) (\w+)[^{;]*\{', source):
        end, depth = match.end(), 1
        while depth:
            if source[end] == '{':
                depth += 1
            elif source[end] == '}':
                depth -= 1
            end += 1
        found[match[1]] = source[match.start():end]
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    checks, pins = [], {}
    for base in ['b0450f79809863039fe775196d2a0b3c89750be7', 'e4d82b718723c6aacabd96e338053b0c7aec5bf9']:
        def old(path):
            return subprocess.check_output(['git', 'show', base + ':' + path], cwd=CORE, text=True)
        paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', base, '--', 'crates/editac-ffi/src'], cwd=CORE, text=True).splitlines()
        for path in paths:
            current = (CORE / path).read_text()
            pins[path] = hashlib.sha256(current.encode()).hexdigest()
            after = declarations(current)
            for name, body in declarations(old(path)).items():
                checks.append(dict(id=base + ':layout:' + name, passed=after.get(name) == body))
        path = 'crates/editac-ffi/generated/EditacNative.swift'
        current = (CORE / path).read_text()
        pattern = r'if \((uniffi_\w+\(\)) != (\d+)\)'
        before, after = dict(re.findall(pattern, old(path))), dict(re.findall(pattern, current))
        assert before
        for name, value in before.items():
            checks.append(dict(id=base + ':checksum:' + name, passed=after.get(name) == value))
        path = 'crates/editac-ffi/generated/EditacNativeFFI.h'
        current = (CORE / path).read_text().splitlines()
        previous = [s for s in old(path).splitlines() if s.strip() and not s.lstrip().startswith('//')]
        checks.append(dict(id=base + ':old-header-declarations', passed=all(s in current for s in previous)))
    failed = sum(not c['passed'] for c in checks)
    report = dict(state='passed' if not failed else 'FAILED', checks=checks, sourceHashes=pins,
                  counts=dict(executed=len(checks), passed=len(checks)-failed, failed=failed, skipped=0))
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['counts']))
    return int(bool(failed))


if __name__ == '__main__':
    raise SystemExit(main())
