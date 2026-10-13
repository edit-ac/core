#!/usr/bin/env python3
"""NAT-1.6 actual Android control, isolated build/emulator and durable receipts."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time

CORE = Path(__file__).resolve().parents[2]
ARCH = CORE.parent / 'architecture'
PACKAGE = 'ac.edit.controlprobe'
spec = importlib.util.spec_from_file_location('kotlin_fixture', CORE/'tests/native/kotlin-fixture.py')
fixture_module = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture_module)
digest = fixture_module.digest

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ARCH/'evidence/native-preparation/nat-1.6-20261013')
    args = parser.parse_args(); out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    receipt = {'gate': 'NAT-1.6', 'source_revision': 'af2c2c354505662117f1bbafbbcc73877551b674bb96a8ac5b07a00591701501',
        'prompt_revision': '2e18a98412c7', 'checks': [], 'qualification': 'actual arm64 Android Emulator EditText/InputConnection preparation only',
        'unqualified': ['physical device', 'real keyboard IME/candidate/autocorrect/dictation', 'composition conflict merge/commit',
                        'semantic native marks/attachments', 'clipboard/accessibility/storage/reconnect', 'SDK parity/performance/release']}
    env = os.environ.copy()
    sdk = Path.home()/'Library/Android/sdk'; ndk = sdk/'ndk/27.1.12297006'
    java = Path('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
    env.update(JAVA_HOME=str(java), ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk))
    env['PATH'] = str(java/'bin') + ':' + str(Path.home()/'.cargo/bin') + ':' + env['PATH']
    adb = sdk/'platform-tools/adb'; emulator = sdk/'emulator/emulator'
    process = None; avd = None; serial = None; inputs = []
    temp_owner = None
    def run(name, command, cwd=CORE, timeout=900, input=None):
        command = list(map(str, command)); log = out/(name+'.log')
        with log.open('w') as stream:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, input=input, text=True)
        receipt['checks'].append({'id': name, 'command': shlex.join(command), 'cwd': str(cwd), 'exit': result.returncode,
                                  'log': str(log), 'sha256': digest(log)})
        (out/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
        print(name + ': exit ' + str(result.returncode), flush=True)
        if result.returncode: raise RuntimeError(name+' failed: '+str(log))
        return log.read_text().strip()
    try:
        prior = ARCH/'evidence/native-preparation/nat-1.4-20261013/receipt.json'
        receipt['prerequisite_receipt_sha256'] = digest(prior)
        inputs = [CORE/'Cargo.toml', CORE/'Cargo.lock', CORE/'tests/native/fixtures/bounded-abi.json',
                  CORE/'crates/editac-ffi/generated/ac/edit/nativebridge/editac_ffi.kt', Path(__file__), CORE/'tests/native/android-control.sh',
                  CORE/'tests/native/kotlin-fixture.py', CORE/'tests/manual/android-probe.md']
        for family in ['editac-ffi', 'editac-core', 'editac-wasm']:
            inputs += [CORE/f'crates/{family}/Cargo.toml'] + sorted((CORE/f'crates/{family}/src').rglob('*.rs'))
        project = CORE/'native/android/probe/control'
        inputs += sorted(p for p in project.rglob('*') if p.is_file())
        receipt['inputs'] = {str(p.relative_to(CORE)): digest(p) for p in inputs}
        with tarfile.open(out/'sources.tar.gz', 'w:gz') as archive:
            for p in inputs: archive.add(p, arcname=str(p.relative_to(CORE)))
        run('java-version', [java/'bin/java', '-version'])
        run('adb-version', [adb, 'version'])
        run('emulator-version', [emulator, '-version'])
        run('rust-version', ['rustc', '+1.97.1', '-Vv'])
        receipt['toolchain'] = {'ndk': (ndk/'source.properties').read_text(), 'api': 36, 'build_tools': '36.0.0',
            'gradle': fixture_module.GRADLE, 'gradle_archive_sha256': fixture_module.GRADLE_SHA256,
            'agp': '8.10.1', 'kotlin': '2.2.0', 'jna': '5.17.0', 'gson': '2.13.1', 'abi': 'arm64-v8a'}
        linker = ndk/'toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android35-clang'
        if not linker.exists(): raise RuntimeError('install NDK 27.1.12297006 for macOS host')
        env['CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER'] = str(linker)
        env['CC_aarch64_linux_android'] = str(linker)
        env['AR_aarch64_linux_android'] = str(linker.parent/'llvm-ar')
        target = CORE/'target/native-android-control'
        run('android-native-build', ['cargo', '+1.97.1', 'build', '-p', 'editac-ffi', '--lib', '--locked',
            '--target', 'aarch64-linux-android', '--target-dir', target])
        library = target/'aarch64-linux-android/debug/libeditac_ffi.so'
        receipt['native_sha256'] = digest(library)
        run('native-abi', [linker.parent/'llvm-readelf', '-h', library])
        archive = CORE/f'target/native-tooling/gradle-{fixture_module.GRADLE}-bin.zip'
        if digest(archive) != fixture_module.GRADLE_SHA256: raise RuntimeError('Gradle distribution checksum mismatch')
        gradle = CORE/f'target/native-tooling/gradle-{fixture_module.GRADLE}/bin/gradle'
        temp_owner = tempfile.TemporaryDirectory(prefix='editac-android-control-')
        # Outer finally stops the emulator before deleting its temporary AVD.
        with contextlib.nullcontext(Path(temp_owner.name)) as work:
            app = work/'project'; shutil.copytree(project, app)
            # Reuse only this harness's dependency cache across relevant repairs.
            env['GRADLE_USER_HOME'] = str(target/'gradle-home')
            bindings = work/'bindings'; bindings.mkdir()
            original = (CORE/'crates/editac-ffi/generated/ac/edit/nativebridge/editac_ffi.kt').read_text()
            compatible = fixture_module.compatible_kotlin(original)
            measured, sites = fixture_module.instrument(compatible)
            (bindings/'editac_ffi.kt').write_text(measured)
            receipt['bindings'] = {'compatibility': 'guarded four Throwable.message overrides; unchanged wire order',
                'instrumentation': sites, 'transformed_sha256': digest(bindings/'editac_ffi.kt')}
            natives = work/'jniLibs/arm64-v8a'; natives.mkdir(parents=True); shutil.copy2(library, natives/library.name)
            assets = work/'assets'; assets.mkdir(); shutil.copy2(CORE/'tests/native/fixtures/bounded-abi.json', assets)
            base = [gradle, '--no-daemon', '--console=plain', '-p', app, f'-PbindingsDir={bindings}',
                    f'-PfixtureDir={assets}', f'-PnativeDir={natives.parent}']
            run('gradle-version', [gradle, '--version'])
            # First implementation resolves the locked Android graph; future runs enforce it.
            build = base + ['assembleDebug']
            if not (project/'gradle.lockfile').exists(): build += ['--write-locks']
            run('gradle-android-build', build, timeout=900)
            if (app/'gradle.lockfile').exists():
                shutil.copy2(app/'gradle.lockfile', project/'gradle.lockfile')
                shutil.copy2(app/'gradle.lockfile', out/'gradle.lockfile')
                receipt['dependency_lock_sha256'] = digest(app/'gradle.lockfile')
            apk = app/'build/outputs/apk/debug/project-debug.apk'
            if not apk.exists():
                apks = list((app/'build/outputs/apk/debug').glob('*.apk'))
                if len(apks) != 1: raise RuntimeError('expected exactly one APK')
                apk = apks[0]
            shutil.copy2(apk, out/'control-debug.apk'); receipt['apk_sha256'] = digest(apk)
            run('apk-inventory', [sdk/'build-tools/36.0.0/aapt', 'list', apk])
            avd = 'editac-nat16-'+str(os.getpid()); env['ANDROID_AVD_HOME'] = str(work/'avd'); Path(env['ANDROID_AVD_HOME']).mkdir()
            run('avd-create', [sdk/'cmdline-tools/latest/bin/avdmanager', 'create', 'avd', '-n', avd,
                '-k', 'system-images;android-36;google_apis;arm64-v8a', '--device', 'pixel'], input='no\n')
            # A unique AVD and free explicit console/adb ports avoid every existing device.
            port = None
            for candidate in range(5580, 5680, 2):
                sockets = []
                try:
                    for p in [candidate, candidate+1]:
                        s = socket.socket(); sockets.append(s); s.bind(('127.0.0.1', p))
                    port = candidate; break
                except OSError: pass
                finally:
                    for s in sockets: s.close()
            if port is None: raise RuntimeError('no free emulator console pair')
            serial = f'emulator-{port}'
            cmd = list(map(str, [emulator, '-avd', avd, '-port', port, '-no-window', '-no-audio', '-no-snapshot', '-gpu', 'swiftshader']))
            with (out/'emulator.log').open('w') as log:
                process = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
            receipt['emulator'] = {'pid': process.pid, 'command': shlex.join(cmd), 'avd': avd, 'serial': serial,
                'image': 'system-images;android-36;google_apis;arm64-v8a', 'ownership': 'created by this harness; terminated and AVD removed in teardown'}
            run('adb-wait', [adb, '-s', serial, 'wait-for-device'], timeout=240)
            deadline = time.monotonic()+240
            while time.monotonic() < deadline:
                state = subprocess.run([str(adb), '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], capture_output=True, text=True)
                if state.stdout.strip() == '1': break
                if process.poll() is not None: raise RuntimeError('emulator exited before boot')
                time.sleep(2)
            else: raise RuntimeError('emulator boot deadline exceeded')
            run('android-properties', [adb, '-s', serial, 'shell', 'getprop'])
            run('apk-install', [adb, '-s', serial, 'install', '-r', apk])
            for name, filter, expected in [('android-narrow', 'native-control-unicode', 1), ('android-control', None, 7)]:
                run(name+'-reset', [adb, '-s', serial, 'shell', 'am', 'force-stop', PACKAGE])
                run(name+'-clear-result', [adb, '-s', serial, 'shell', 'run-as', PACKAGE, 'rm', '-f', 'files/result.json'])
                command = [adb, '-s', serial, 'shell', 'am', 'start', '-W', '-n', PACKAGE+'/.ProbeActivity']
                if filter: command += ['--es', 'case', filter]
                run(name+'-launch', command)
                deadline = time.monotonic()+60; result = None
                while time.monotonic() < deadline:
                    p = subprocess.run([str(adb), '-s', serial, 'shell', 'run-as', PACKAGE, 'cat', 'files/result.json'], capture_output=True, text=True)
                    if p.returncode == 0:
                        try: result = json.loads(p.stdout); break
                        except json.JSONDecodeError: pass
                    time.sleep(1)
                if result is None:
                    run(name+'-logcat', [adb, '-s', serial, 'logcat', '-d'], timeout=30)
                    raise RuntimeError(name+' produced no result')
                (out/(name+'.json')).write_text(json.dumps(result, indent=2)+'\n')
                receipt[name] = {'counts': result['counts'], 'result_sha256': digest(out/(name+'.json'))}
                print(name+': '+json.dumps(result['counts']), flush=True)
                if result['counts'] != {'executed': expected, 'passed': expected, 'failed': 0, 'skipped': 0}:
                    raise RuntimeError(name+' actual-control assertions failed; repair before retry')
            run('app-teardown', [adb, '-s', serial, 'shell', 'am', 'force-stop', PACKAGE])
            run('apk-uninstall', [adb, '-s', serial, 'uninstall', PACKAGE])
            run('emulator-stop', [adb, '-s', serial, 'emu', 'kill'])
            process.wait(timeout=30)
            receipt['cleanup'] = {'emulator_exit': process.returncode, 'temporary_build_avd_removed': True,
                'dependency_cache': str(target/'gradle-home')}
        receipt['status'] = 'PASS'
    except Exception as e:
        receipt['status'] = 'FAIL'; receipt['error'] = str(e); print(str(e), file=sys.stderr)
    finally:
        if process is not None and process.poll() is None:
            # Exact child process owned by this harness; no broad process-name signals.
            process.terminate()
            try: process.wait(timeout=20)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=10)
            receipt['cleanup'] = {'emulator_exit': process.returncode, 'temporary_build_avd_removed': True,
                'dependency_cache': str(CORE/'target/native-android-control/gradle-home')}
        if temp_owner is not None: temp_owner.cleanup()
        receipt['inputs_final'] = {str(p.relative_to(CORE)): digest(p) for p in inputs if p.exists()}
        mutations = [p for p, h in receipt.get('inputs', {}).items() if receipt['inputs_final'].get(p) != h]
        if mutations:
            receipt['status'] = 'FAIL'; receipt['source_mutations_during_checks'] = mutations
        (out/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    return 0 if receipt['status'] == 'PASS' else 1

if __name__ == '__main__': sys.exit(main())
