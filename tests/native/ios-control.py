#!/usr/bin/env python3
"""Build and execute NAT-1.5 on a private, task-owned actual iOS Simulator."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone

CORE = Path(__file__).resolve().parents[2]
ARCH = CORE.parent / 'architecture'
SOURCE = ARCH / 'progress/.roadmap-runner/09-native-preparation-9c393cca2aad/source-d18a82d0de7a.md'
BUNDLE = 'ac.edit.nativepreparation.controlprobe'
RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
DEVICE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'gate': 'NAT-1.5', 'startedUtc': datetime.now(timezone.utc).isoformat(),
               'checks': [], 'state': 'unfinished', 'counts': {'executed': 0, 'passed': 0, 'failed': 0, 'skipped': 0},
               'scope': 'iOS Simulator UIKit/TextKit; not device, real keyboard IME, SDK, performance or release support',
               'sourceSnapshot': str(SOURCE), 'sourceRevision': digest(SOURCE)}
    env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
    env['PATH'] = str(Path.home() / '.cargo/bin') + ':' + env['PATH']
    simulator = None
    def run(name, command, timeout=300, allow_failure=False):
        log = output / (name + '.log')
        with log.open('w') as stream:
            completed = subprocess.run([str(x) for x in command], cwd=CORE, env=env,
                                       stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        receipt['checks'].append({'id': name, 'command': shlex.join([str(x) for x in command]),
                                 'exit': completed.returncode, 'log': log.name, 'sha256': digest(log)})
        if completed.returncode and not allow_failure:
            raise RuntimeError(f'{name} exited {completed.returncode}; see {log}')
        return log.read_text()
    try:
        # Reuse immutable prerequisite receipts, but rebuild current iOS artifacts.
        upstream = ARCH / 'evidence/engine-completion-review/receipt.json'
        engine = json.loads(upstream.read_text())
        assert engine['source_revision'] == digest(ARCH / 'roadmaps/02-engine.md')
        assert receipt['sourceRevision'] == 'af2c2c354505662117f1bbafbbcc73877551b674bb96a8ac5b07a00591701501'
        prerequisite = ARCH / 'evidence/native-preparation/nat-1.3-20261013/receipt.json'
        assert json.loads(prerequisite.read_text())['counts'] == {'executed': 9, 'passed': 9, 'failed': 0, 'skipped': 0}
        receipt['prerequisites'] = {str(p.relative_to(ARCH)): digest(p) for p in [upstream, prerequisite]}
        receipt['coreRevision'] = run('core-revision', ['git', 'rev-parse', 'HEAD']).strip()
        receipt['architectureRevision'] = subprocess.check_output(['git', '-C', str(ARCH), 'rev-parse', 'HEAD'], text=True).strip()
        version = run('xcode-version', ['xcodebuild', '-version'])
        assert version.strip() == 'Xcode 26.6\nBuild version 17F113', version
        run('swift-version', ['xcrun', 'swiftc', '--version'])
        sdk = run('sdk-path', ['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path']).strip()
        env['SDKROOT'] = sdk
        env['IPHONEOS_DEPLOYMENT_TARGET'] = '26.5'
        receipt['buildEnvironment'] = {'DEVELOPER_DIR': env['DEVELOPER_DIR'], 'SDKROOT': sdk, 'IPHONEOS_DEPLOYMENT_TARGET': '26.5'}
        sdk_version = run('sdk-version', ['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version']).strip()
        assert sdk_version == '26.5', sdk_version
        run('simulator-runtimes', ['xcrun', 'simctl', 'list', 'runtimes', '-j'])
        # Unique target directory prevents writes to another task's build tree.
        target = CORE / 'target/native-ios-control'
        run('native-build', [Path.home()/'.cargo/bin/cargo', '+1.97.1', 'build', '-p', 'editac-ffi',
                             '--lib', '--target', 'aarch64-apple-ios-sim', '--target-dir', target, '--locked'], timeout=900)
        library = target / 'aarch64-apple-ios-sim/debug/libeditac_ffi.a'
        inputs = [CORE/'native/ios/probe/UIKit/Probe.swift', CORE/'tests/native/fixtures/bounded-abi.json',
                  CORE/'crates/editac-ffi/generated/EditacNative.swift',
                  CORE/'crates/editac-ffi/generated/EditacNativeFFI.h',
                  CORE/'crates/editac-ffi/generated/EditacNativeFFI.modulemap',
                  CORE/'Cargo.toml', CORE/'Cargo.lock', library, Path(__file__), CORE/'tests/native/ios-control.sh']
        inputs += sorted((CORE/'crates/editac-ffi/src').rglob('*.rs'))
        inputs += sorted((CORE/'crates/editac-core/src').rglob('*.rs'))
        inputs += sorted((CORE/'crates/editac-wasm/src').rglob('*.rs'))
        inputs += [CORE/f'crates/{crate}/Cargo.toml' for crate in ['editac-ffi', 'editac-core', 'editac-wasm']]
        receipt['inputs'] = {str(p.relative_to(CORE)): digest(p) for p in inputs}
        shutil.copy2(Path(__file__), output/'ios-control.py')
        shutil.copy2(CORE/'native/ios/probe/UIKit/Probe.swift', output/'Probe.swift')
        shutil.copy2(CORE/'tests/native/fixtures/bounded-abi.json', output/'bounded-abi.json')
        with tempfile.TemporaryDirectory(prefix='editac-ios-control-') as temp:
            app = Path(temp) / 'NativeControlProbe.app'; app.mkdir()
            executable = app/'NativeControlProbe'
            generated = CORE/'crates/editac-ffi/generated'
            run('swift-build', ['xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-Onone',
                               '-target', 'arm64-apple-ios26.5-simulator', '-sdk', sdk, '-parse-as-library',
                               '-I', generated, '-Xcc', '-fmodule-map-file='+str(generated/'EditacNativeFFI.modulemap'),
                               CORE/'native/ios/probe/UIKit/Probe.swift', generated/'EditacNative.swift', library,
                               '-framework', 'UIKit', '-framework', 'Foundation', '-lc++', '-o', executable], timeout=300)
            shutil.copy2(CORE/'tests/native/fixtures/bounded-abi.json', app/'bounded-abi.json')
            info = {'CFBundleIdentifier': BUNDLE, 'CFBundleExecutable': 'NativeControlProbe',
                    'CFBundleName': 'NativeControlProbe', 'CFBundlePackageType': 'APPL',
                    'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0',
                    'MinimumOSVersion': '26.5', 'LSRequiresIPhoneOS': True,
                    'UIDeviceFamily': [1], 'UILaunchScreen': {}}
            (app/'Info.plist').write_bytes(plistlib.dumps(info))
            run('codesign', ['codesign', '--force', '--sign', '-', app])
            receipt['executableSha256'] = digest(executable)
            # Retain actual qualification binary; temporary app removed in teardown.
            shutil.copy2(executable, output/'NativeControlProbe')
            simulator = run('simulator-create', ['xcrun', 'simctl', 'create', 'editac-NAT-1.5-'+str(os.getpid()), DEVICE, RUNTIME]).strip()
            receipt['simulator'] = {'udid': simulator, 'type': DEVICE, 'runtime': RUNTIME, 'ownership': 'created by this harness; deleted in teardown'}
            run('simulator-boot', ['xcrun', 'simctl', 'boot', simulator])
            run('simulator-ready', ['xcrun', 'simctl', 'bootstatus', simulator, '-b'], timeout=300)
            run('simulator-install', ['xcrun', 'simctl', 'install', simulator, app])
            run('simulator-launch', ['xcrun', 'simctl', 'launch', simulator, BUNDLE])
            container = Path(run('simulator-container', ['xcrun', 'simctl', 'get_app_container', simulator, BUNDLE, 'data']).strip())
            result = container/'Documents/result.json'
            deadline = time.monotonic()+90
            while not result.exists() and time.monotonic() < deadline:
                time.sleep(0.5)
            if not result.exists():
                raise RuntimeError('actual UIKit app did not write results within 90 seconds')
            shutil.copy2(result, output/'result.json')
            results = json.loads(result.read_text())
            receipt['counts'] = results['counts']
            receipt['cases'] = [{'id': c['id'], 'state': c['state']} for c in results['cases']]
            receipt['host'] = results['host']
            run('simulator-screenshot', ['xcrun', 'simctl', 'io', simulator, 'screenshot', output/'control.png'])
            counts = receipt['counts']
            assert counts['executed'] == 7 and counts['passed'] == 7 and counts['failed'] == 0 and counts['skipped'] == 0, counts
            assert {c['id'] for c in results['cases']} == {'real-textkit-control', 'local-batched-utf16-range-selection',
                'remote-crdt-range-selection', 'marked-text-rust-ownership-remote-queue', 'custom-mark-textkit-rendering',
                'inline-native-attachment', 'copies-batching-disposal'}
            receipt['state'] = 'locally verified on iOS Simulator, not deployed'
    except Exception as error:
        receipt['error'] = str(error)
        receipt['state'] = 'failed'
    finally:
        if simulator:
            run('simulator-terminate', ['xcrun', 'simctl', 'terminate', simulator, BUNDLE], allow_failure=True)
            run('simulator-shutdown', ['xcrun', 'simctl', 'shutdown', simulator], allow_failure=True)
            run('simulator-delete', ['xcrun', 'simctl', 'delete', simulator], allow_failure=True)
        receipt['finishedUtc'] = datetime.now(timezone.utc).isoformat()
        receipt['artifacts'] = {p.name: digest(p) for p in output.iterdir() if p.is_file()}
        (output/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps({'state': receipt['state'], 'counts': receipt['counts'], 'error': receipt.get('error'), 'receipt': str(output/'receipt.json')}))
    return 0 if receipt['state'].startswith('locally verified') else 1

if __name__ == '__main__':
    raise SystemExit(main())
