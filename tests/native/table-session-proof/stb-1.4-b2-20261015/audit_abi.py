"""Compare prior public layouts and generated method checksums exactly."""
from pathlib import Path
import json, re, subprocess

core = Path(__file__).resolve().parents[4]
out = Path(__file__).resolve().parent
baseline = '730f44177da1bc8598f614e7908f22171cdfced5'

def old(path):
    return subprocess.check_output(['git', 'show', baseline + ':' + path], cwd=core, text=True)

def declarations(source):
    found = {}
    for match in re.finditer(r'pub (?:struct|enum) (\w+)[^{;]*\{', source):
        end = match.end()
        depth = 1
        while depth:
            if source[end] == '{': depth += 1
            elif source[end] == '}': depth -= 1
            end += 1
        found[match[1]] = source[match.start():end]
    return found

checks = []
for path in ['crates/editac-ffi/src/session.rs', 'crates/editac-ffi/src/session_commands.rs', 'crates/editac-ffi/src/lib.rs', 'crates/editac-ffi/src/session_collaboration.rs', 'crates/editac-ffi/src/session_presence.rs']:
    before = declarations(old(path))
    after = declarations((core / path).read_text())
    for name, body in before.items():
        checks.append({'id': 'layout:' + name, 'passed': after.get(name) == body})
path = 'crates/editac-ffi/generated/EditacNative.swift'
pattern = r'if \((uniffi_\w+\(\)) != (\d+)\)'
before = dict(re.findall(pattern, old(path)))
after = dict(re.findall(pattern, (core / path).read_text()))
assert before
for name, value in before.items():
    checks.append({'id': 'checksum:' + name, 'passed': after.get(name) == value})
path = 'crates/editac-ffi/generated/EditacNativeFFI.h'
prior = [line for line in old(path).splitlines() if line.strip() and not line.lstrip().startswith('//')]
current = set((core / path).read_text().splitlines())
checks.append({'id': 'all-prior-header-lines-preserved', 'passed': all(line in current for line in prior)})
report = {'baseline': baseline, 'checks': checks, 'counts': {
    'executed': len(checks), 'passed': sum(c['passed'] for c in checks),
    'failed': sum(not c['passed'] for c in checks), 'skipped': 0}}
(out / 'abi-audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report['counts']))
raise SystemExit(bool(report['counts']['failed']))
