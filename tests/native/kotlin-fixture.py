#!/usr/bin/env python3
"""NAT-1.4 canonical real JVM/JNA host, with prepared corpus and no providers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

CORE = Path(__file__).resolve().parents[2]
ARCH = CORE.parent / 'architecture'
GRADLE = '8.14'
GRADLE_SHA256 = '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def compatible_kotlin(source):
    # UniFFI 0.32.2 emits both a payload property and synthesized Throwable.message
    # for these variants. Keep the identical payload/order/codec; use one override.
    old = 'val `message`: kotlin.String\n        ) : NativeException() {\n        override val message\n            get() = "message=${ `message` }"'
    new = 'override val `message`: kotlin.String\n        ) : NativeException() {'
    if source.count(old) != 4:
        raise RuntimeError('expected four UniFFI typed-error message collisions')
    return source.replace(old, new)

def instrument(source):
    source = source.replace('package ac.edit.nativebridge', 'package ac.edit.nativebridge\nimport BoundaryProbe', 1)
    sites = [
        ('val byteBuf = toUtf8(value)\n        // Ideally', 'val byteBuf = toUtf8(value)\n        BoundaryProbe.record("copy.string-to-rust", byteBuf.limit())\n        // Ideally'),
        ('override fun read(buf: ByteBuffer): String {\n        val len = buf.getInt()', 'override fun read(buf: ByteBuffer): String {\n        val len = buf.getInt()\n        BoundaryProbe.record("copy.string-field", len)'),
        ('override fun lift(value: RustBuffer.ByValue): String {\n        try {', 'override fun lift(value: RustBuffer.ByValue): String {\n        BoundaryProbe.record("copy.string-direct", value.len.toInt())\n        try {'),
        ('override fun read(buf: ByteBuffer): ByteArray {\n        val len = buf.getInt()', 'override fun read(buf: ByteBuffer): ByteArray {\n        val len = buf.getInt()\n        BoundaryProbe.record("copy.bytes-field", len)'),
        ('override fun write(value: ByteArray, buf: ByteBuffer) {', 'override fun write(value: ByteArray, buf: ByteBuffer) {\n        BoundaryProbe.record("copy.bytes-to-rust", value.size)')]
    for old, new in sites:
        if source.count(old) != 1:
            raise RuntimeError('generated instrumentation site changed: ' + old)
        source = source.replace(old, new)
    start = source.index('open class NativeEngine:')
    end = source.index('public object FfiConverterTypeNativeEngine', start)
    engine, count = re.subn(r'(fun `([A-Za-z]+)`\([^\n]*\)\s*(?::[^\n{]+)?\s*\{)',
        lambda m: m[0] + '\n        BoundaryProbe.record("call.' + m[2] + '")', source[start:end])
    # Three Unit-returning methods are generated as expression bodies.
    engine, unit_count = re.subn(r'(fun `([A-Za-z]+)`\([^\n]*\)\s*=\s*callWithHandle \{)',
        lambda m: m[0] + '\n        BoundaryProbe.record("call.' + m[2] + '")', engine)
    count += unit_count
    if count != 19 or unit_count != 3:
        raise RuntimeError(f'expected 19 engine sites including 3 expression bodies, got {count}/{unit_count}')
    return source[:start] + engine + source[end:], {'engine_method_sites': count, 'conversion_sites': len(sites),
        'scope': 'serial generated JVM allocation/copy sites; excludes Rust staging, JNA internals, allocator internals and timing'}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reuse-semantic', action='store_true', help='reuse unchanged passing host evidence after measurement-only repair')
    parser.add_argument('--output', type=Path, default=ARCH / 'evidence/native-preparation/nat-1.4-20261013')
    args = parser.parse_args()
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    previous = json.loads((out / 'receipt.json').read_text()) if args.reuse_semantic else None
    prior_path = ARCH / 'evidence/native-preparation/nat-1.2-20261013/receipt.json'
    prior = json.loads(prior_path.read_text())
    bindings = json.loads((prior_path.parent / 'bindings-receipt.json').read_text())
    generated = CORE / 'crates/editac-ffi/generated'
    kotlin = generated / 'ac/edit/nativebridge/editac_ffi.kt'
    fixture = CORE / 'tests/native/fixtures/bounded-abi.json'
    library = CORE / 'target/debug/libeditac_ffi.dylib'
    probe = CORE / 'native/android/probe'
    receipt = {'gate': 'NAT-1.4', 'checks': [], 'source_revision': prior['source_revision'], 'prompt_revision': '2e18a98412c7',
        'qualification': 'macOS arm64 JVM/JNA headless preparation only; Android ABI builds, EditText, device, SDK, performance and release unqualified',
        'unqualified': ['Android cross-compiled library/ABI packaging', 'Android emulator/device/control', 'GC finalization timing'],
        'prerequisite_receipt_sha256': digest(prior_path), 'reused_native_build': bindings['checks'][0],
        'fixture_sha256': digest(fixture), 'rust_expectations': 'crates/editac-ffi/tests/native_abi.rs',
        'swift_receipt_sha256': digest(ARCH / 'evidence/native-preparation/nat-1.3-20261013/receipt.json')}
    env = os.environ.copy()
    env['JAVA_HOME'] = os.environ.get('EDITAC_NATIVE_JAVA_HOME', '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
    env['PATH'] = env['JAVA_HOME'] + '/bin:' + env['PATH']
    def run(name, command, cwd=CORE):
        log = out / (name + '.log')
        with log.open('w') as stream:
            result = subprocess.run(list(map(str, command)), cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
        receipt['checks'].append({'id': name, 'command': shlex.join(list(map(str, command))), 'cwd': str(cwd),
            'exit': result.returncode, 'log': str(log), 'sha256': digest(log)})
        if result.returncode:
            # Preserve actual counts even on a failed host run.
            if name.startswith('kotlin-') and name in ['kotlin-narrow', 'kotlin-host', 'kotlin-copies']:
                try: receipt[name] = json.loads(log.read_text())
                except json.JSONDecodeError: pass
            raise RuntimeError(f'{name} failed; see {log}')
        return log
    try:
        if platform.system() != 'Darwin' or platform.machine() != 'arm64':
            raise RuntimeError('qualified library requires macOS arm64 host; provision that host or qualify a new matching native build')
        if digest(library) != bindings['library']['sha256']:
            raise RuntimeError('native library differs from qualified NAT-1.2; requalify before reuse')
        for path, expected in {**prior['source_hashes'], **bindings['artifacts']}.items():
            if digest((CORE.parent if path.startswith('core/') else CORE) / path) != expected:
                raise RuntimeError('qualified source/generated artifact changed: ' + path)
        if digest(fixture) != bindings['fixture_sha256']:
            raise RuntimeError('shared fixture differs from Rust qualification')
        receipt['source_hashes'] = {str(p.relative_to(CORE)): digest(p) for p in sorted(probe.rglob('*')) if p.is_file()}
        receipt['implementation_revision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CORE, text=True).strip()
        receipt['library'] = {'path': str(library), 'sha256': digest(library), 'target': 'aarch64-apple-darwin', 'transport': 'JVM JNA dynamic library loading'}
        run('library-abi', ['/usr/bin/file', library])
        run('java-version', ['java', '-version'])
        tooling = CORE / 'target/native-tooling'; tooling.mkdir(parents=True, exist_ok=True)
        archive = tooling / f'gradle-{GRADLE}-bin.zip'
        if not archive.exists(): urllib.request.urlretrieve(f'https://downloads.gradle.org/distributions/gradle-{GRADLE}-bin.zip', archive)
        if digest(archive) != GRADLE_SHA256: raise RuntimeError('Gradle archive hash mismatch')
        gradle = tooling / f'gradle-{GRADLE}/bin/gradle'
        if not gradle.exists():
            with zipfile.ZipFile(archive) as z: z.extractall(tooling)
            gradle.chmod(0o755)
        receipt['tooling'] = {'gradle': GRADLE, 'archive_sha256': GRADLE_SHA256, 'kotlin': '2.2.0', 'jna': '5.17.0', 'gson': '2.13.1', 'java_home': env['JAVA_HOME']}
        # All caches/build output are fixture-owned and temporary; no shared Gradle daemons.
        with tempfile.TemporaryDirectory(prefix='editac-kotlin-') as temp:
            work = Path(temp); env['GRADLE_USER_HOME'] = str(work / 'gradle-home')
            project = work / 'probe'; shutil.copytree(probe, project, ignore=shutil.ignore_patterns('build', '.gradle'))
            compatible = work / 'compatible/ac/edit/nativebridge/editac_ffi.kt'
            compatible.parent.mkdir(parents=True); compatible.write_text(compatible_kotlin(kotlin.read_text()))
            receipt['compiler_compatibility'] = {'reason': 'UniFFI 0.32.2 duplicate Throwable.message declarations', 'variants': 4, 'scope': 'temporary Kotlin source only; unchanged Rust ABI and wire field order/codecs', 'sha256': digest(compatible)}
            base = [gradle, '--no-daemon', '--console=plain', '-p', project, f'-PbindingsDir={work / "compatible"}']
            run('gradle-version', [gradle, '--version'])
            dist = project / 'build/install/editac-kotlin-headless-probe'
            java = ['java', f'-Duniffi.component.editac_ffi.libraryOverride={library}', '-cp', str(dist / 'lib/*'), 'ProbeKt', fixture]
            if previous:
                for path, expected in previous['source_hashes'].items():
                    if digest(CORE / path) != expected:
                        raise RuntimeError('semantic source changed; cannot reuse: ' + path)
                for key in ['fixture_sha256']:
                    if receipt[key] != previous[key]: raise RuntimeError('semantic fixture changed')
                if receipt['library']['sha256'] != previous['library']['sha256'] or digest(kotlin) != previous['package']['generated_sha256']:
                    raise RuntimeError('semantic native library/generated binding changed')
                if receipt['compiler_compatibility']['sha256'] != previous['compiler_compatibility']['sha256']:
                    raise RuntimeError('semantic compatibility source changed')
                reused = [c for c in previous['checks'] if c['id'] in ['kotlin-build', 'kotlin-narrow', 'kotlin-host']]
                if len(reused) != 3 or any(c['exit'] or digest(Path(c['log'])) != c['sha256'] for c in reused):
                    raise RuntimeError('semantic logs missing/failed/changed')
                for suite in ['narrow', 'integration']:
                    counts = previous[suite]['counts']
                    if not counts['executed'] or counts['failed'] or counts['skipped']:
                        raise RuntimeError('cannot reuse incomplete/failed suite')
                receipt['checks'].extend(reused)
                for key in ['narrow', 'integration', 'package']: receipt[key] = previous[key]
                receipt['reused_semantic_evidence'] = True
            else:
                lock_args = [] if (probe / 'gradle.lockfile').exists() else ['--write-locks']
                run('kotlin-build', base + lock_args + ['installDist'])
                if lock_args: shutil.copy2(project / 'gradle.lockfile', probe / 'gradle.lockfile')
                jars = sorted((dist / 'lib').glob('*.jar'))
                receipt['package'] = {'kind': 'Gradle application distribution with JVM jar and pinned JNA dependencies; native library loaded via explicit JVM property',
                    'jars': {p.name: digest(p) for p in jars}, 'generated_sha256': digest(kotlin), 'host_sha256': digest(probe / 'src/main/kotlin/Probe.kt')}
                receipt['narrow'] = json.loads(run('kotlin-narrow', java + ['unicode-batch-patch']).read_text())
                receipt['integration'] = json.loads(run('kotlin-host', java).read_text())
            observed, receipt['instrumentation'] = instrument(compatible.read_text())
            measured = work / 'bindings/ac/edit/nativebridge/editac_ffi.kt'; measured.parent.mkdir(parents=True); measured.write_text(observed)
            receipt['instrumented_generated_sha256'] = digest(measured)
            measured_base = [gradle, '--no-daemon', '--console=plain', '-p', project, f'-PbindingsDir={work / "bindings"}']
            run('kotlin-instrumented-build', measured_base + ['installDist'])
            receipt['copies'] = json.loads(run('kotlin-copies', java + ['boundary-copies']).read_text())
        receipt['source_hashes'] = {str(p.relative_to(CORE)): digest(p) for p in sorted(probe.rglob('*')) if p.is_file()}
        receipt['harness_hashes'] = {str(p.relative_to(CORE)): digest(p) for p in [CORE / 'tests/native/kotlin-fixture.py', CORE / 'tests/native/kotlin-fixture.sh']}
        receipt['counts'] = {key: sum(receipt[s]['counts'][key] for s in ['integration', 'copies']) for key in ['executed', 'passed', 'failed', 'skipped']}
        for suite in ['narrow', 'integration', 'copies']:
            counts = receipt[suite]['counts']
            if not counts['executed'] or counts['failed'] or counts['skipped']: raise RuntimeError('nonempty passing suite required: ' + suite)
        with tarfile.open(out / 'host-sources.tar.gz', 'w:gz') as tar:
            for path in [probe, CORE / 'tests/native/kotlin-fixture.py', CORE / 'tests/native/kotlin-fixture.sh', fixture]:
                tar.add(path, arcname=str(path.relative_to(CORE)), filter=lambda info: None if '/build/' in info.name or '/.gradle/' in info.name else info)
        receipt['source_archive_sha256'] = digest(out / 'host-sources.tar.gz')
        receipt['state'] = 'implemented/verified; not deployed'
    except Exception as error:
        receipt['state'] = 'FAILED'; receipt['error'] = str(error); print(str(error), file=sys.stderr)
    finally:
        receipt['artifact_hashes'] = {p.name: digest(p) for p in out.glob('*.log')}
        path = out / 'receipt.json'
        # Keep historical failed evidence when a repaired run replaces the active receipt.
        if path.exists():
            old = json.loads(path.read_text())
            if old.get('state') == 'FAILED':
                failure = out / ('failed-' + digest(path)[:12]); failure.mkdir(exist_ok=True)
                shutil.copy2(path, failure / 'receipt.json')
                # Logs were archived at failure time below, before any future rerun.
        path.write_text(json.dumps(receipt, indent=2) + '\n')
        if receipt['state'] == 'FAILED':
            failure = out / ('failed-' + digest(path)[:12]); failure.mkdir(exist_ok=True)
            shutil.copy2(path, failure / 'receipt.json')
            for log in out.glob('*.log'): shutil.copy2(log, failure / log.name)
    print(json.dumps({'state': receipt['state'], 'counts': receipt.get('counts'), 'receipt': str(out / 'receipt.json')}))
    return 1 if receipt['state'] == 'FAILED' else 0

if __name__ == '__main__': sys.exit(main())
