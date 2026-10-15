#!/usr/bin/env python3
"""NCB extension of the canonical session-swift.py harness; actual SQLite/UniFFI.

Compose unchanged canonical Session and rich cases with command cases, preserving
the same generated-source buffer instrumentation and unchanged legacy consumer.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

CORE = Path(__file__).resolve().parents[3]
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--rich-fixture', type=Path)
    parser.add_argument('--table-fixture', type=Path)
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--fixture-writer', type=Path)
    parser.add_argument('--reuse-legacy', type=Path)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    attempt = out / ('attempt-' + str(1 + len(list(out.glob('attempt-*')))))
    attempt.mkdir()
    generated = CORE / 'crates/editac-ffi/generated'
    library = CORE / 'target/debug/libeditac_ffi.dylib'
    env = os.environ.copy()
    env['PATH'] = '/Users/bpstr/.nvm/versions/node/v24.19.0/bin:/Users/bpstr/.cargo/bin:' + env['PATH']
    checks = []
    receipt = {'gate': 'NCB-1.3', 'state': 'FAILED', 'checks': checks,
        'sourceRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CORE, text=True).strip(),
        'qualification': 'macOS aarch64 actual generated Swift + shared Session SQLite; no AppKit/IME/platform/release/deployment qualification',
        'providerCalls': 0, 'publication': False}
    def run(name, command):
        log = attempt / (name + '.log')
        with log.open('w') as stream:
            result = subprocess.run(list(map(str, command)), cwd=CORE, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=180)
        checks.append({'id': name, 'command': shlex.join(list(map(str, command))), 'exit': result.returncode,
            'log': str(log.relative_to(CORE)), 'sha256': digest(log)})
        if result.returncode:
            raise RuntimeError(name + ' failed: ' + str(log))
        return log
    try:
        binding_receipt = out / 'bindings-receipt.json'
        bindings = json.loads(binding_receipt.read_text())
        if bindings['counts']['failed'] or bindings['counts']['skipped'] or not bindings['counts']['executed']:
            raise RuntimeError('binding admission incomplete')
        if digest(library) != bindings['library']['sha256']:
            raise RuntimeError('compiled library changed after generation')
        for p, expected in bindings['artifacts'].items():
            if digest(CORE / p) != expected:
                raise RuntimeError('generated artifact changed: ' + p)
        receipt['bindingsReceiptSha256'] = digest(binding_receipt)
        receipt['library'] = {'path': str(library.relative_to(CORE)), 'sha256': digest(library)}
        receipt['generatedArtifacts'] = bindings['artifacts']
        paths = ['tests/native/session-command-proof/run.py', 'tests/native/session-command-proof/CommandCases.swift', 'crates/editac-ffi/src/session_commands.rs', 'tests/native/session-swift.py', 'tests/native/session-probe/main.swift', 'tests/native/session-probe/RichCases.swift', 'tests/native/bounded-bindings.py',
            'crates/editac-ffi/src/session.rs', 'crates/editac-ffi/src/lib.rs', 'crates/editac-ffi/Cargo.toml', 'Cargo.lock',
            'native/ios/probe/main.swift', 'tests/native/fixtures/bounded-abi.json']
        receipt['sourceHashes'] = {p: digest(CORE / p) for p in paths}
        receipt['toolchain'] = run('swift-version', ['xcrun', 'swiftc', '--version']).read_text().strip()
        run('host-version', ['sw_vers'])
        with tempfile.TemporaryDirectory(prefix='nsr-swift-') as temp:
            work = Path(temp)
            base = ['xcrun', 'swiftc', '-swift-version', '5', '-Onone', '-I', generated,
                '-Xcc', '-fmodule-map-file=' + str(generated / 'EditacNativeFFI.modulemap'),
                '-L', library.parent, '-leditac_ffi', '-Xlinker', '-rpath', '-Xlinker', library.parent]
            canonical = CORE / 'tests/native/session-probe/main.swift'
            host = work / 'main.swift'
            extra_entry = 'runTablePolicyCases()\n' if args.table_fixture else ''
            marker = 'if let index = CommandLine.arguments.firstIndex(of: "--rich-fixture") {'
            host.write_text(canonical.read_text().replace(marker, 'runCommandCases()\n' + extra_entry + marker))
            command_source = CORE / 'tests/native/session-command-proof/CommandCases.swift'
            receipt['composedHostSha256'] = digest(host)
            (attempt / 'main.swift').write_bytes(host.read_bytes())
            rich_source = CORE / 'tests/native/session-probe/RichCases.swift'
            table_sources = [CORE / 'tests/native/table-session-proof/TablePolicyCases.swift'] if args.table_fixture else []
            if args.table_fixture:
                receipt['tableFixtureManifestSha256'] = digest(args.table_fixture)
                receipt['tableFixtureStoreSha256'] = digest(Path(json.loads(args.table_fixture.read_text())['path']))
                receipt['sourceHashes'][str(table_sources[0].relative_to(CORE))] = digest(table_sources[0])
            rich_args = ['--rich-fixture', args.rich_fixture.resolve()] if args.rich_fixture else []
            if args.fixture_writer:
                rich_args += ['--fixture-writer', args.fixture_writer.resolve()]
                receipt['fixtureWriterSha256'] = digest(args.fixture_writer)
            if args.rich_fixture:
                receipt['fixtureManifestSha256'] = digest(args.rich_fixture)
                receipt['fixtureStoreSha256Before'] = digest(Path(json.loads(args.rich_fixture.read_text())['path']))
            if args.table_fixture:
                rich_args += ['--table-fixture', args.table_fixture.resolve()]
            binary = work / 'session-probe'
            run('session-build', base + [generated / 'EditacNative.swift', host, rich_source, command_source, *table_sources, '-o', binary])
            receipt['binarySha256'] = digest(binary)
            (attempt / 'session-probe').write_bytes(binary.read_bytes())
            result = run('session-runtime', [binary, attempt / 'stores', *rich_args, *[arg for case in args.case for arg in ['--case', case]]])
            receipt['runtime'] = json.loads(result.read_text())
            # Observe real deallocation sites only in a disposable generated copy.
            # Raw library and the semantic executable above remain unmodified.
            swift = (generated / 'EditacNative.swift').read_text()
            substitutions = [
                ('public static func lift(_ buf: RustBuffer) throws -> SwiftType {', '\n        BufferProbe.lift(buf.data)'),
                ('public static func lift(_ value: RustBuffer) throws -> String {', '\n        BufferProbe.lift(value.data)'),
                ('func deallocate() {', '\n        BufferProbe.free(self.data)'),
                ('try! rustCall { uniffi_editac_ffi_fn_free_nativesession(handle, $0) }', '\n        BufferProbe.event("handle")')]
            for needle, addition in substitutions:
                if swift.count(needle) != 1:
                    raise RuntimeError('generated instrumentation site changed: ' + needle)
                swift = swift.replace(needle, needle + addition)
            instrumented = work / 'MeasuredBindings.swift'
            instrumented.write_text(swift)
            receipt['instrumentedGeneratedSha256'] = digest(instrumented)
            (attempt / 'MeasuredBindings.swift').write_text(swift)
            measured = work / 'session-buffers'
            run('session-instrumented-build', base + [instrumented, host, rich_source, command_source, *table_sources, '-o', measured])
            receipt['instrumentedBinarySha256'] = digest(measured)
            (attempt / 'session-buffers').write_bytes(measured.read_bytes())
            result = run('session-buffer-runtime', [measured, attempt / 'measured-stores', '--instrumented', *rich_args])
            receipt['buffers'] = json.loads(result.read_text())
            if args.reuse_legacy:
                previous = json.loads(args.reuse_legacy.read_text())
                if previous['library'] != receipt['library'] or previous['generatedArtifacts'] != receipt['generatedArtifacts']:
                    raise RuntimeError('legacy reuse library/generated inputs changed')
                for p in ['native/ios/probe/main.swift', 'tests/native/fixtures/bounded-abi.json']:
                    if previous['sourceHashes'][p] != digest(CORE / p):
                        raise RuntimeError('legacy reuse input changed: ' + p)
                receipt['legacy'] = previous['legacy']
                receipt['legacyReuse'] = {'receipt': str(args.reuse_legacy.resolve()), 'sha256': digest(args.reuse_legacy)}
            else:
                legacy = work / 'legacy-probe'
                run('legacy-build', base + [generated / 'EditacNative.swift', CORE / 'native/ios/probe/main.swift', '-o', legacy])
                receipt['legacyBinarySha256'] = digest(legacy)
                (attempt / 'legacy-probe').write_bytes(legacy.read_bytes())
                result = run('legacy-runtime', [legacy, CORE / 'tests/native/fixtures/bounded-abi.json'])
                receipt['legacy'] = json.loads(result.read_text())
        for key in ['runtime', 'buffers', 'legacy']:
            counts = receipt[key]['counts']
            if not counts['executed'] or counts['executed'] != counts['passed'] or counts['failed'] or counts['skipped']:
                raise RuntimeError('incomplete runtime: ' + key)
        receipt['selectedCases'] = args.case
        receipt['counts'] = {key: sum(receipt[phase]['counts'][key] for phase in (['runtime', 'buffers'] if args.reuse_legacy else ['runtime', 'buffers', 'legacy']))
            for key in ['executed', 'passed', 'failed', 'skipped']}
        receipt['state'] = 'implemented/verified; not integrated or deployed'
    except Exception as error:
        receipt['error'] = str(error)
    finally:
        receipt['attempt'] = str(attempt.relative_to(CORE))
        receipt['artifactHashes'] = {str(p.relative_to(CORE)): digest(p) for p in attempt.rglob('*') if p.is_file()}
        data = json.dumps(receipt, indent=2) + '\n'
        (attempt / 'receipt.json').write_text(data)
        (out / 'receipt.json').write_text(data)
    print(json.dumps({k: receipt.get(k) for k in ['state', 'counts', 'error', 'attempt']}))
    return int(receipt['state'] == 'FAILED')

if __name__ == '__main__':
    raise SystemExit(main())
