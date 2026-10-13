#!/usr/bin/env python3
"""Compile and execute NAT-1.3 against the real native UniFFI library."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

CORE = Path(__file__).resolve().parents[2]
ARCH = CORE.parent / 'architecture'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse-semantic", action="store_true", help="after measurement-only repair, reuse hash-identical passing compiled host evidence")
    parser.add_argument('--output', type=Path, default=ARCH / 'evidence/native-preparation/nat-1.3-20261013')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Immutable qualification inputs are verified before reusing the native build.
    prior_path = ARCH / 'evidence/native-preparation/nat-1.2-20261013/receipt.json'
    prior = json.loads(prior_path.read_text())
    bindings = json.loads((prior_path.parent / 'bindings-receipt.json').read_text())
    library = CORE / 'target/debug/libeditac_ffi.dylib'
    generated = CORE / 'crates/editac-ffi/generated'
    fixture = CORE / 'tests/native/fixtures/bounded-abi.json'
    previous = json.loads((out / "receipt.json").read_text()) if args.reuse_semantic else None
    checks = []
    receipt = {'gate': 'NAT-1.3', 'checks': checks, 'qualification': 'macOS aarch64 Swift headless preparation only; no iOS control/device, SDK, performance or release qualification',
               'prerequisite_receipt_sha256': digest(prior_path), 'reused_native_build': bindings['checks'][0],
               'fixture_sha256': digest(fixture), 'rust_expectations': 'crates/editac-ffi/tests/native_abi.rs',
               'source_revision': prior['source_revision'], 'prompt_revision': '2e18a98412c7'}
    env = os.environ.copy()
    env['PATH'] = str(Path.home() / '.cargo/bin') + ':' + env['PATH']
    def run(name, command):
        log = out / (name + '.log')
        with log.open('w') as stream:
            result = subprocess.run(list(map(str, command)), cwd=CORE, env=env, stdout=stream, stderr=subprocess.STDOUT)
        check = {'id': name, 'command': shlex.join(list(map(str, command))), 'exit': result.returncode,
                 'log': str(log), 'sha256': digest(log)}
        checks.append(check)
        if result.returncode:
            raise RuntimeError(f'{name} failed; see {log}')
        return log
    try:
        if digest(library) != bindings['library']['sha256']:
            raise RuntimeError('native library differs from qualified NAT-1.2; rebuild/regenerate and requalify before reuse')
        for path, expected in {**prior['source_hashes'], **bindings['artifacts']}.items():
            if digest((CORE.parent if path.startswith("core/") else CORE) / path) != expected:
                raise RuntimeError('qualified source/generated artifact changed: ' + path)
        if digest(fixture) != bindings['fixture_sha256']:
            raise RuntimeError('shared fixture differs from Rust qualification')
        receipt['library'] = {'path': str(library), 'sha256': digest(library)}
        receipt['generated_artifacts'] = bindings['artifacts']
        receipt['source_hashes'] = {p: digest(CORE / p) for p in [
            'native/ios/probe/main.swift', 'tests/native/swift-fixture.sh', 'tests/native/swift-fixture.py',
            'crates/editac-ffi/tests/native_abi.rs', 'tests/native/fixtures/bounded-abi.json']}
        receipt['implementation_revision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CORE, text=True).strip()
        receipt['toolchains'] = {}
        for name, command in [('swift-version', ['xcrun', 'swiftc', '--version']), ('xcode-version', ['xcodebuild', '-version']),
                              ('sdk-version', ['xcrun', '--sdk', 'macosx', '--show-sdk-version']), ('host-version', ['sw_vers'])]:
            receipt['toolchains'][name] = run(name, command).read_text().strip()
        with tempfile.TemporaryDirectory(prefix='editac-swift-native-') as temp:
            work = Path(temp)
            base = ['xcrun', 'swiftc', '-swift-version', '5', '-Onone', '-I', generated,
                    '-Xcc', '-fmodule-map-file=' + str(generated / 'EditacNativeFFI.modulemap'),
                    '-L', library.parent, '-leditac_ffi', '-Xlinker', '-rpath', '-Xlinker', library.parent]
            host = CORE / 'native/ios/probe/main.swift'
            binary = work / 'swift-fixture'
            if previous:
                paths = ['native/ios/probe/main.swift', 'crates/editac-ffi/tests/native_abi.rs', 'tests/native/fixtures/bounded-abi.json']
                if any(previous['source_hashes'][p] != digest(CORE / p) for p in paths) or previous['library'] != receipt['library'] or previous['generated_artifacts'] != receipt['generated_artifacts']:
                    raise RuntimeError('semantic evidence inputs changed; full run required')
                reused = [c for c in previous['checks'] if c['id'] in ['swift-build', 'swift-narrow', 'swift-host']]
                if len(reused) != 3 or any(c['exit'] or digest(Path(c['log'])) != c['sha256'] for c in reused):
                    raise RuntimeError('semantic evidence missing/failed/changed')
                checks.extend(reused)
                for key in ['binary_sha256', 'narrow', 'integration']:
                    receipt[key] = previous[key]
                receipt['reused_semantic_evidence'] = True
            else:
                run('swift-build', base + [generated / 'EditacNative.swift', host, '-o', binary])
                receipt['binary_sha256'] = digest(binary)
                narrow = run('swift-narrow', [binary, fixture, 'unicode-batch-patch'])
                receipt['narrow'] = json.loads(narrow.read_text())
                integration = run('swift-host', [binary, fixture])
                receipt['integration'] = json.loads(integration.read_text())
            # Observe exact generated conversion sites in a disposable copy, keeping
            # checked-in generator output and the semantic build unmodified.
            swift = (generated / 'EditacNative.swift').read_text()
            substitutions = [
                ('static func from(_ ptr: UnsafeBufferPointer<UInt8>) -> RustBuffer {',
                 'BoundaryProbe.record("copy.host-to-rust", ptr.count)'),
                ('public static func lift(_ value: RustBuffer) throws -> String {',
                 'BoundaryProbe.record("decode.string-direct", Int(value.len))'),
                ('public static func read(from buf: inout (data: Data, offset: Data.Index)) throws -> String {\\n        let len: Int32 = try readInt(&buf)',
                 'BoundaryProbe.record("decode.string-field", Int(len))'),
                ('public static func read(from buf: inout (data: Data, offset: Data.Index)) throws -> Data {\\n        let len: Int32 = try readInt(&buf)',
                 'BoundaryProbe.record("copy.data-field", Int(len))')]
            for needle, statement in substitutions:
                needle = needle.replace('\\n', '\n')
                if swift.count(needle) != 1:
                    raise RuntimeError('instrumentation site changed: ' + needle)
                swift = swift.replace(needle, needle + '\n        ' + statement)
            # Adding a statement removes Swift's single-expression implicit return.
            swift = swift.replace('try! rustCall { ffi_editac_ffi_rustbuffer_from_bytes', 'return try! rustCall { ffi_editac_ffi_rustbuffer_from_bytes')
            start = swift.index("open class NativeEngine")
            end = swift.index("public struct FfiConverterTypeNativeEngine", start)
            engine, count = re.subn(r'((?:open|public static) func (\w+)\([^\n{]*\{)',
                lambda m: m[0] + '\n    BoundaryProbe.record("call.' + m[2] + '")\n', swift[start:end])
            swift = swift[:start] + engine + swift[end:]
            if count != 19:
                raise RuntimeError(f'expected 19 engine calls, found {count}')
            instrumented = work / 'InstrumentedBindings.swift'
            instrumented.write_text(swift)
            receipt['instrumented_generated_sha256'] = digest(instrumented)
            receipt['instrumentation'] = {'engine_method_sites': count, 'conversion_sites': len(substitutions),
                'scope': 'serial host only; observed generated copy/decode sites, excluding Rust staging, allocator internals and timing'}
            measured = work / 'swift-copies'
            run('swift-instrumented-build', base + [instrumented, host, '-o', measured])
            receipt['instrumented_binary_sha256'] = digest(measured)
            copies = run('swift-copies', [measured, fixture, 'boundary-copies'])
            receipt['copies'] = json.loads(copies.read_text())
            # All-256-byte coverage uses the generated OwnedCheckpoint converter
            # in the host added below, not a substitute Rust engine transport.
        counts = [receipt[key]['counts'] for key in ['integration', 'copies']]
        receipt['counts'] = {key: sum(c[key] for c in counts) for key in ['executed', 'passed', 'failed', 'skipped']}
        if not receipt['counts']['executed'] or receipt['counts']['failed'] or receipt['counts']['skipped']:
            raise RuntimeError('incomplete/failed host cases')
        receipt['state'] = 'implemented/verified; not deployed'
    except Exception as error:
        receipt['state'] = 'FAILED'
        receipt['error'] = str(error)
        print(str(error), file=sys.stderr)
    finally:
        receipt['artifact_hashes'] = {p.name: digest(p) for p in out.glob('*.log')}
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'state': receipt['state'], 'counts': receipt.get('counts'), 'receipt': str(out / 'receipt.json')}))
    return 0 if receipt['state'] != 'FAILED' else 1

if __name__ == '__main__':
    sys.exit(main())
