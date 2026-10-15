#!/usr/bin/env python3
"""NAT-1.2 native metadata generation and cross-language signature check."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

CORE = Path(__file__).resolve().parents[2]
CARGO = Path.home() / '.cargo/bin/cargo'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(name, command, out, env):
    log = out / (name + '.log')
    with log.open('w') as stream:
        p = subprocess.run(command, cwd=CORE, env=env, stdout=stream, stderr=subprocess.STDOUT)
    return {'id': name, 'command': shlex.join(map(str, command)), 'exit': p.returncode,
            'log': str(log), 'sha256': digest(log)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--audit-only', action='store_true', help='reuse unchanged generated artifacts after an audit repair')
    args = parser.parse_args()
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env['PATH'] = str(CARGO.parent) + os.pathsep + env.get('PATH', '')
    checks = []
    base = [str(CARGO), '+1.97.1']
    library = CORE / 'target/debug/libeditac_ffi.dylib'
    generated = CORE / 'crates/editac-ffi/generated'
    if args.audit_only:
        previous = json.loads((out / 'bindings-receipt.json').read_text())
        if previous['library']['sha256'] != digest(library) or any(digest(CORE / p) != h for p, h in previous['artifacts'].items()):
            raise RuntimeError('artifact changed; full build/generation required')
        checks = [c for c in previous['checks'] if c['id'] in ('native-build', 'generate-bindings')]
        if len(checks) != 2 or any(c['exit'] for c in checks):
            raise RuntimeError('no passing build/generator evidence to reuse')
    else:
        checks.append(run('native-build', base + ['build', '-p', 'editac-ffi', '--lib', '--locked'], out, env))
        library = CORE / 'target/debug/libeditac_ffi.dylib'
        if checks[-1]['exit'] or not library.is_file():
            raise RuntimeError('native library build missing/failed; see native-build.log')
        generated = CORE / 'crates/editac-ffi/generated'
        generated.mkdir(parents=True, exist_ok=True)
        checks.append(run('generate-bindings', base + ['run', '-p', 'editac-ffi', '--features', 'bindgen', '--bin', 'editac-uniffi-bindgen', '--locked', '--', 'generate', '--library', str(library), '--language', 'swift', '--language', 'kotlin', '--out-dir', str(generated), '--no-format'], out, env))
        if checks[-1]['exit']:
            raise RuntimeError('generator failed; see generate-bindings.log')
    swift_path = generated / 'EditacNative.swift'
    kotlin_path = generated / 'ac/edit/nativebridge/editac_ffi.kt'
    swift = swift_path.read_text().replace('`', ''); kotlin = kotlin_path.read_text().replace("`", "").replace("kotlin.", "")
    assertions = []
    def check(name, condition):
        assertions.append({'id': name, 'passed': bool(condition)})
    # Both are emitted from the exact same ABI metadata; audit host type mappings.
    check('swift-utf16-u32', bool(re.search(r'offsetUtf16\s*:\s*UInt32', swift)))
    check('kotlin-utf16-u32', bool(re.search(r'offsetUtf16\s*:\s*UInt', kotlin)))
    check('swift-owned-bytes', bool(re.search(r'bytes\s*:\s*Data', swift)))
    check('kotlin-owned-bytes', bool(re.search(r'bytes\s*:\s*ByteArray', kotlin)))
    methods = ['read', 'checkpoint', 'executeBatch', 'prepareBatch', 'commitBatch', 'cancelBatch', 'captureAnchor', 'resolveAnchor', 'exportAnchor', 'importAnchor', 'releaseAnchor', 'stateVector', 'encodeUpdate', 'applyUpdate', 'takePatch', 'history', 'dispose']
    for method in methods:
        check('shared-method-' + method, bool(re.search(r'func\s+' + method + r'\s*\(', swift)) and bool(re.search(r'fun\s+' + method + r'\s*\(', kotlin)))
    for record in ['AbiVersion', 'AnchorInput', 'OwnedCheckpoint', 'BatchResult', 'NativeSessionPeerUpdate']:
        check('shared-record-' + record, ('struct ' + record in swift) and ('data class ' + record in kotlin))
    for error in ['InvalidInput', 'EngineRejected', 'InvalidHandle', 'ResourceLimit', 'Disposed', 'ExecutorUnavailable']:
        check('shared-error-' + error, error in swift and error in kotlin)
    # The additive durable Session shares this library/metadata, never another ABI.
    for method in ['attachHostTransport', 'detachHostTransport', 'flushHostTransport', 'flushHostTransportPage', 'takeHostFrames', 'receiveHostPeer', 'acceptHostReceipt', 'reservePeerWriter', 'receivePeer', 'pendingUpdates', 'createLocal', 'open', 'prepareEdits', 'commitEdits', 'cancelEdits', 'setPermission', 'recoveryExport', 'recover', 'undo', 'redo']:
        check('session-method-' + method, bool(re.search(r'func\s+' + method + r'\s*\(', swift)) and bool(re.search(r'fun\s+' + method + r'\s*\(', kotlin)))
    for record in ['NativeHostTransportOptions', 'NativeHostFrame', 'NativeHostReceipt', 'NativeSessionOptions', 'NativeSessionSeed', 'NativeSessionRead', 'NativeSessionEdit', 'NativeSessionRecovery', 'NativeSessionCommit']:
        check('session-record-' + record, ('struct ' + record in swift) and ('data class ' + record in kotlin))
    for error in ['NativeHostReceiptResult', 'NativeSessionError', 'NativeStoreFailure', 'NativeRevisionFailure']:
        check('session-error-' + error, error in swift and error in kotlin)
    check('session-optional-owned-revision', 'revision: Data?' in swift and 'revision: ByteArray?' in kotlin)
    check('no-engine-internals', not any(re.search(r'\b' + term + r'\b', swift + kotlin) for term in ['Yrs', 'PreparedEditorEdit', 'DocumentIdentity', 'Bridge', 'NativePointer']))
    check('no-callback-interface', 'uniffi::export(callback_interface)' not in (CORE / 'crates/editac-ffi/src/lib.rs').read_text() and 'FfiConverterCallbackInterface' not in swift + kotlin)
    check('pinned-generator', 'version = "0.32.2"' in (CORE / 'Cargo.lock').read_text() and 'uniffi = "=0.32.2"' in (CORE / 'crates/editac-ffi/Cargo.toml').read_text())
    checks.append(run('swift-interface-typecheck', ['xcrun', 'swiftc', '-typecheck', '-I', str(generated), '-Xcc', '-fmodule-map-file=' + str(generated / 'EditacNativeFFI.modulemap'), str(swift_path)], out, env))
    check('swift-interface-compiles', checks[-1]['exit'] == 0)
    failed = sum(not a['passed'] for a in assertions)
    receipt = {'gate': 'NAT-1.2', 'checks': checks, 'interface_assertions': assertions,
               'counts': {'executed': len(assertions), 'passed': len(assertions)-failed, 'failed': failed, 'skipped': 0},
               'artifacts': {str(p.relative_to(CORE)): digest(p) for p in sorted(generated.rglob('*')) if p.is_file()},
               'library': {'path': str(library), 'sha256': digest(library)},
               'reused_build_generation': args.audit_only,
               'fixture_sha256': digest(CORE / 'tests/native/fixtures/bounded-abi.json'),
               'qualification': 'Native Rust bridge and generated interfaces only; no Swift/Kotlin host or device execution.'}
    (out / 'bindings-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt['counts']))
    if failed:
        print('Failed assertions: ' + ', '.join(a['id'] for a in assertions if not a['passed']))
    return int(bool(failed))

if __name__ == '__main__':
    sys.exit(main())
