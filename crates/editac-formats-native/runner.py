#!/usr/bin/env python3
"""Optional local native RTF consumer. No downloads, ambient credentials or fallback.

The public run() retains original bytes on every outcome. Only complete correlated
worker results are returned; the caller decides retention and subsequent host use.
Import creates a new Session; export restores a supplied initialized Session checkpoint.
Neither route mutates a live host document or marks it saved.
"""
import dataclasses
import hashlib
import json
import os
import pathlib
import platform
import resource
import signal
import subprocess
import sys
import tempfile
import time
import threading

SANDBOX = '/usr/bin/sandbox-exec'
MAX_INPUT = 1024 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
RUST_HEAP = 64 * 1024 * 1024
_ACTIVE = threading.BoundedSemaphore(1)
RUNTIME = ['/usr/lib', '/System/Library/dyld',
           '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld',
           '/System/Volumes/Preboot/Cryptexes/OS/usr/lib',
           '/System/Cryptexes/OS/System/Library/dyld',
           '/System/Cryptexes/OS/usr/lib']

@dataclasses.dataclass(frozen=True)
class Result:
    outcome: dict
    original: bytes


def _file_hash(path):
    with path.open('rb') as source:
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
        return digest.hexdigest()

def run(binary, binary_sha256, original, *, wall_ms=4000, output_bytes=MAX_OUTPUT,
        cancel=None):
    """Import into one isolated shared Session. This profile never approves loss.

    All limits may only be reduced. Native runtime/stack/allocator overhead is
    outside the 64MiB hard requested-Rust-heap ceiling; RSS is sampled separately.
    The caller supplies the exact reviewed executable hash, never a document URL.
    """
    if not _ACTIVE.acquire(blocking=False):
        data = bytes(original)
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, original, 'rtf-import', (), wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()


def run_table(binary, binary_sha256, original, *, dialect, wall_ms=4000,
              output_bytes=MAX_OUTPUT, cancel=None):
    """Import a text table using an explicit reviewed dialect; never detect/evaluate.

    delimiter: comma/tab; quote: double; escape: double; encoding: utf8/utf8-bom;
    newline: lf/crlf; header: none/first-row; ragged: reject. All seven required.
    Originals remain caller-owned on every outcome. Completion creates a new
    shared Session; subsequent host insertion/save is separately authorized.
    """
    data = bytes(original)
    required = dict(delimiter=('comma','tab'), quote=('double',), escape=('double',),
                    encoding=('utf8','utf8-bom'), newline=('lf','crlf'),
                    header=('none','first-row'), ragged=('reject',))
    if (not isinstance(dialect, dict) or set(dialect) != set(required) or
        any(dialect[k] not in values for k, values in required.items())):
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_DIALECT_REQUIRED',
                           executed=0, outputAccepted=False, childExited=True,
                           originalSha256=hashlib.sha256(data).hexdigest()), data)
    # Freeze all caller-owned values before process startup.
    args = tuple(dialect[k] for k in ('newline','encoding','header'))
    mode = 'csv-import' if dialect['delimiter']=='comma' else 'tsv-import'
    if not _ACTIVE.acquire(blocking=False):
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, data, mode, args, wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()


def _table_completion_valid(payload, original, args):
    """Admit only a complete correlated immutable table completion."""
    try:
        report = payload['report']
        checkpoint = payload['checkpoint']
        return (payload.get('dialect') == list(args) and
                isinstance(checkpoint, list) and bool(checkpoint) and
                all(type(n) is int and 0 <= n <= 255 for n in checkpoint) and
                hashlib.sha256(bytes(checkpoint)).hexdigest() == payload.get('checkpointSha256') and
                all(payload.get(k) is True for k in ('undo','redo','reopen')) and
                payload.get('commits') == 1 and payload.get('activeJobs') == 0 and
                payload.get('assets') == 0 and payload.get('networkCalls') == 0 and
                isinstance(payload.get('documentId'), str) and type(payload.get('writerId')) is int and 0 < payload['writerId'] < 2**64 and
                isinstance(report, dict) and report.get('diagnostics') == [] and
                type(report.get('scannedBytes')) is int and report['scannedBytes'] == len(original) and
                type(report.get('rows')) is int and 0 < report['rows'] <= 128 and
                type(report.get('columns')) is int and 0 < report['columns'] <= 32 and
                type(report.get('cells')) is int and report['cells'] == report['rows']*report['columns'] <= 1024 and
                type(report.get('utf16Units')) is int and 0 <= report['utf16Units'] <= 262144 and
                report.get('headerRows') == int(args[2]=='first-row') and
                report.get('bomRemoved') is original.startswith(b'\xef\xbb\xbf') and
                isinstance(payload.get('snapshotBlocks'), list) and
                isinstance(payload.get('preparedBlocks'), list) and
                0 < payload.get('peakRustHeapBytes', 0) <= RUST_HEAP)
    except (ValueError, TypeError, KeyError, IndexError):
        return False


def run_export(binary, binary_sha256, checkpoint_request, *, wall_ms=4000,
               output_bytes=MAX_OUTPUT, cancel=None):
    """Export an initialized checkpoint through the captured shared Session writer.

    checkpoint_request is a UTF-8 JSON envelope with documentId, writerId,
    checkpoint bytes and checkpointSha256. Original envelope bytes are retained
    on every outcome. approveLoss is explicit and defaults to false. No save or
    journal durability transition is implied by successful conversion.
    """
    if not _ACTIVE.acquire(blocking=False):
        data = bytes(checkpoint_request)
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, checkpoint_request, 'rtf-export', (), wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()


def run_table_export(binary, binary_sha256, checkpoint_request, *, wall_ms=4000,
                     output_bytes=MAX_OUTPUT, cancel=None):
    """Export one explicitly selected captured table; preserve request for recovery."""
    if not _ACTIVE.acquire(blocking=False):
        data = bytes(checkpoint_request)
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, checkpoint_request, 'table-export', (), wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()


def run_odt_export(binary, binary_sha256, checkpoint_request, *, wall_ms=4000,
                   output_bytes=MAX_OUTPUT, cancel=None):
    """Export ODF1.3 from a checkpoint with explicit host-approved originals.

    approvedAssets contains caller-granted {host,key,bytes} records, separate
    from document metadata; absent grants deny every read. Retain Result.original
    (the exact request including the checkpoint/assets) on every outcome.
    """
    if not _ACTIVE.acquire(blocking=False):
        data = bytes(checkpoint_request)
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, checkpoint_request, 'odt-export', (), wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()


def run_docx_export(binary, binary_sha256, checkpoint_request, *, wall_ms=4000,
                   output_bytes=MAX_OUTPUT, cancel=None):
    """Export DOCX semantic profile from a checkpoint with explicit host-approved originals.

    approvedAssets contains caller-granted {host,key,bytes} records, separate
    from document metadata; absent grants deny every read. Retain Result.original
    (the exact request including the checkpoint/assets) on every outcome.
    """
    if not _ACTIVE.acquire(blocking=False):
        data = bytes(checkpoint_request)
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, checkpoint_request, 'docx-export', (), wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()


def run_epub_export(binary, binary_sha256, checkpoint_request, *, wall_ms=4000,
                   output_bytes=MAX_OUTPUT, cancel=None):
    """Export EPUB 3.3 reflowable profile from a checkpoint with explicit host-approved originals.

    approvedAssets contains caller-granted {host,key,bytes} records, separate
    from document metadata; absent grants deny every read. Retain Result.original
    (the exact request including the checkpoint/assets) on every outcome.
    """
    if not _ACTIVE.acquire(blocking=False):
        data = bytes(checkpoint_request)
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, checkpoint_request, 'epub-export', (), wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()

def run_pdf_export(binary, binary_sha256, checkpoint_request, *, wall_ms=4000,
                   output_bytes=MAX_OUTPUT, cancel=None):
    """Export PDF bounded publication profile from a checkpoint with explicit host-approved originals.

    approvedAssets contains caller-granted {host,key,bytes} records, separate
    from document metadata; absent grants deny every read. Retain Result.original
    (the exact request including the checkpoint/assets) on every outcome.
    """
    if not _ACTIVE.acquire(blocking=False):
        data = bytes(checkpoint_request)
        return Result(dict(schemaVersion=1, state='unavailable', code='FORMAT_BUSY', executed=0,
                           outputAccepted=False, childExited=True, originalSha256=hashlib.sha256(data).hexdigest()), data)
    try:
        return _run(binary, binary_sha256, checkpoint_request, 'pdf-export', (), wall_ms, output_bytes, cancel)
    finally:
        _ACTIVE.release()


def run_odt_import(binary, binary_sha256, original, *, approve_loss=False,
                   wall_ms=4000, output_bytes=MAX_OUTPUT, cancel=None):
    """New local Session only. Media is unavailable pending shared atomic adoption.

    Keep Result.original under host retention policy on every outcome.
    """
    if type(approve_loss) is not bool:
        data=bytes(original)
        return Result(dict(state='unavailable',code='FORMAT_REQUEST_INVALID',executed=0,
                           outputAccepted=False,childExited=True,originalSha256=hashlib.sha256(data).hexdigest()),data)
    return _run(binary,binary_sha256,original,'odt-import',
                ('approve-loss' if approve_loss else 'strict',),wall_ms,output_bytes,cancel)

def run_docx_import(binary, binary_sha256, original, *, approve_loss=False,
                   wall_ms=4000, output_bytes=MAX_OUTPUT, cancel=None):
    """New local Session only. Media is unavailable pending shared atomic adoption.

    Keep Result.original under host retention policy on every outcome.
    """
    if type(approve_loss) is not bool:
        data=bytes(original)
        return Result(dict(state='unavailable',code='FORMAT_REQUEST_INVALID',executed=0,
                           outputAccepted=False,childExited=True,originalSha256=hashlib.sha256(data).hexdigest()),data)
    return _run(binary,binary_sha256,original,'docx-import',
                ('approve-loss' if approve_loss else 'strict',),wall_ms,output_bytes,cancel)

def _container_import_completion_valid(payload, original, args):
    try:
        report=payload['report']
        if not isinstance(report,dict) or not isinstance(report.get('diagnostics'),list):return False
        if not all(isinstance(d,dict) and all(isinstance(d.get(k),str) and d[k] for k in ('code','location','action')) and type(d.get('lossy')) is bool for d in report['diagnostics']):return False
        return (payload.get('commits') == 1 and type(payload['commits']) is int and
                all(type(payload.get(k)) is int and payload[k] == 1 for k in ('historyGroups','updates')) and
                all(type(payload.get(k)) is int and payload[k] == 0 for k in ('activeJobs','assets','networkCalls')) and
                all(payload.get(k) is True for k in ('undo','redo','reopen')) and
                payload.get('lossApproved') is (args[0] == 'approve-loss') and
                isinstance(payload.get('preparedBlocks'),list) and len(payload['preparedBlocks']) > 0 and
                type(report['blocks']) is int and report['blocks'] == len(payload['preparedBlocks']) and
                type(report['stagedBytes']) is int and report['stagedBytes'] == 0 and isinstance(report['diagnostics'],list) and
                (not any(d['lossy'] for d in report['diagnostics']) or payload['lossApproved']) and
                isinstance(payload.get('snapshotBlocks'),list) and
                isinstance(payload['checkpoint'],list) and all(type(b) is int and 0 <= b <= 255 for b in payload['checkpoint']) and
                hashlib.sha256(bytes(payload['checkpoint'])).hexdigest() == payload['checkpointSha256'])
    except (KeyError,TypeError,ValueError,OverflowError):
        return False

def _export_completion_valid(payload, original, table=False, odt=False, docx=False, epub=False, pdf=False):
    """Reject incomplete or malformed worker envelopes before exposing output."""
    try:
        request = json.loads(original)
        artifact = payload.get('artifact')
        checkpoint = request.get('checkpoint')
        def byte_list(value):
            return isinstance(value, list) and bool(value) and all(type(n) is int and 0 <= n <= 255 for n in value)
        report = payload.get('report')
        if not isinstance(report, dict) or not isinstance(report.get('diagnostics'), list):
            return False
        diagnostics = report['diagnostics']
        if not all(isinstance(d, dict) and isinstance(d.get('code'), str) and d['code'] and
                   isinstance(d.get('location'), str) and d['location'] and
                   type(d.get('lossy')) is bool for d in diagnostics):
            return False
        if odt or docx or epub:
            if not {'PACKAGE_REGENERATED','PAGE_STYLE_DEFAULTS' if docx else 'STYLE_DEFAULTS','METADATA_DEFAULTS'} <= {d['code'] for d in diagnostics}:
                return False
            if not all(type(report.get(k)) is int and report[k] >= 0 for k in ('assets','originalBytes')):
                return False
            if type(payload.get('assets')) is not int or payload['assets'] != report['assets']:
                return False
            work=report.get('mediaWork')
            if not isinstance(work,dict) or not all(type(work.get(k)) is int and work[k] >= 0 for k in ('pixels','decodedBytes','decodeCalls')):
                return False
            if type(payload.get('networkCalls')) is not int or payload['networkCalls'] != 0 or request.get('profile') != ('edit-ac-epub-v1' if epub else 'edit-ac-docx-v1' if docx else 'edit-ac-odt-v1'):
                return False
        if epub and 'CHAPTER_NAVIGATION_POLICY' not in {d['code'] for d in diagnostics}:
            return False
        if pdf:
            if (request.get('profile') != 'edit-ac-pdf-publication-v1' or request.get('fontSet') != 'noto-pinned-v1'
                or report.get('fontSet') != request['fontSet'] or 'LAYOUT_DEFAULTS' not in {d['code'] for d in diagnostics}
                or not all(type(report.get(k)) is int and report[k] >= 0 for k in
                    ('pages','shapedBytes','lines','cells','images','originalBytes','pixels','pngScanBytes','pngScanCalls','fontBytesEmbedded'))
                or not 1 <= report['pages'] <= 8 or report['fontBytesEmbedded'] < 1000000
                or type(payload.get('assets')) is not int or payload['assets'] < 0
                or type(payload.get('networkCalls')) is not int or payload['networkCalls'] != 0
                or not byte_list(artifact) or not bytes(artifact).startswith(b'%PDF-')):
                return False
        if table:
            if 'TEXT_ONLY_FORMAT'  not in {d['code'] for d in diagnostics}:
                return False
            if not isinstance(request.get('selectedTable'), str) or not request['selectedTable']:
                return False
            if not all(type(report.get(k)) is int and report[k] >= 0 for k in ('rows','columns','cells','transformedCells')):
                return False
            if not (report['rows'] > 0 and report['columns'] > 0 and report['cells'] == report['rows'] * report['columns'] and report['transformedCells'] <= report['cells']):
                return False
            safe = 'spreadsheet-safe' in request['profile']
            if not safe and report['transformedCells'] != 0:
                return False
            if report['transformedCells'] != sum(d['code'] == 'SPREADSHEET_SAFE_PREFIX' for d in diagnostics):
                return False
        elif not pdf and not {('PAGE_STYLE_DEFAULTS' if docx else 'STYLE_DEFAULTS'), 'METADATA_DEFAULTS'} <= {d['code'] for d in diagnostics}:
            return False
        if any(d['lossy'] for d in diagnostics) and request.get('approveLoss') is not True:
            return False
        return (payload.get('direction') == 'export' and
                payload.get('liveUnchanged') is True and payload.get('reopen') is True and
                type(payload.get('activeJobs')) is int and payload['activeJobs'] == 0 and
                type(report.get('nodes')) is int and report['nodes'] >= 0 and
                (odt or docx or epub or pdf or (type(report.get('utf16Units')) is int and report['utf16Units'] >= 0)) and
                byte_list(artifact) and byte_list(checkpoint) and
                payload.get('sourceCheckpointSha256') == request.get('checkpointSha256') and
                hashlib.sha256(bytes(checkpoint)).hexdigest() == request.get('checkpointSha256') and
                isinstance(payload.get('revision'), str) and bool(payload['revision']) and
                payload['revision'] == payload.get('capturedRevision') and
                isinstance(payload.get('currentRevision'), str) and bool(payload['currentRevision']) and
                ('laterText' in request or payload['revision'] == payload['currentRevision']) and
                hashlib.sha256(bytes(artifact)).hexdigest() == payload.get('artifactSha256'))
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return False


def _run(binary, binary_sha256, original, mode, args=(), wall_ms=4000,
         output_bytes=MAX_OUTPUT, cancel=None):
    start = time.monotonic()
    original = bytes(original)
    outcome = dict(schemaVersion=1, state='unavailable', code=None, executed=0,
                   profile={'csv-import':'edit-ac-csv-v1','tsv-import':'edit-ac-tsv-v1'}.get(mode,'edit-ac-rtf-v1'), direction='export' if mode in ('rtf-export','table-export','odt-export','docx-export','epub-export','pdf-export') else 'import',
                   target=platform.platform(), originalSha256=hashlib.sha256(original).hexdigest(),
                   originalBytes=len(original), childExited=True, outputAccepted=False,
                   hardRustHeapBytes=RUST_HEAP, peakObservedRssBytes=0, rssSamples=0,
                   maxSampleIntervalMs=0, peakHostRssBytes=0, peakObservedHostAndWorkerRssBytes=0, resourceModel='hard Rust requested heap; RLIMIT_CPU/FSIZE/NOFILE; wall/cancel; sampled process RSS')
    if mode in ('odt-export','odt-import'): outcome['profile'] = 'edit-ac-odt-v1'
    if mode in ('docx-export','docx-import'): outcome['profile'] = 'edit-ac-docx-v1'
    if mode == 'epub-export': outcome['profile'] = 'edit-ac-epub-v1'
    if mode == 'pdf-export': outcome['profile'] = 'edit-ac-pdf-publication-v1'
    if mode == 'table-export':
        try: outcome['profile'] = json.loads(original).get('profile')
        except (ValueError, AttributeError): pass
    child = None
    try:
        if len(original) > MAX_INPUT:
            raise ValueError('FORMAT_INPUT_LIMIT')
        if not isinstance(wall_ms, int) or not 0 < wall_ms <= 4000 or not isinstance(output_bytes, int) or not 0 < output_bytes <= MAX_OUTPUT:
            raise ValueError('FORMAT_RESOURCE_PROFILE_UNAVAILABLE')
        if platform.system() != 'Darwin' or platform.machine() != 'arm64' or not pathlib.Path(SANDBOX).is_file():
            raise ValueError('FORMAT_ISOLATION_UNAVAILABLE')
        if mode not in ('csv-import', 'tsv-import', 'rtf-import', 'rtf-export', 'table-export', 'odt-export', 'docx-export', 'epub-export', 'pdf-export', 'odt-import', 'docx-import', 'export-fixture', 'read', 'write', 'network', 'child', 'spin', 'heap', 'output'):
            raise ValueError('FORMAT_PROFILE_UNAVAILABLE')
        binary = pathlib.Path(binary).resolve(strict=True)
        if not binary.is_file() or _file_hash(binary) != binary_sha256:
            raise ValueError('FORMAT_ENGINE_UNAVAILABLE')
        if cancel is not None and cancel.is_set():
            raise ValueError('FORMAT_CANCELLED')
        with tempfile.TemporaryDirectory(prefix='editac-native-') as temp:
            root = pathlib.Path(temp)
            stdout, stderr, policy_path = [root / p for p in ('stdout', 'stderr', 'sandbox.sb')]
            literal = lambda p: '(literal ' + json.dumps(str(p)) + ')'
            subpath = lambda p: '(subpath ' + json.dumps(str(p)) + ')'
            policy = '\n'.join([
                '(version 1)', '(deny default)',
                '(allow file-read* file-test-existence (literal "/") ' + ' '.join('(path-ancestors ' + json.dumps(p) + ')' for p in RUNTIME) + ')',
                '(allow syscall-unix (syscall-number SYS___mac_syscall SYS_getfsstat SYS_getfsstat64 SYS_map_with_linking_np SYS_open SYS_openat SYS_fstatat SYS_fstatat64 SYS_dup))',
                '(allow system-fcntl (fcntl-command F_ADDFILESIGS_RETURN F_CHECK_LV F_GETPATH))',
                '(with-filter (mac-policy-name "Sandbox") (allow system-mac-syscall (mac-syscall-number 2)))',
                '(allow process-exec ' + literal(binary) + ')',
                '(allow file-map-executable ' + literal(binary) + ' ' + ' '.join(map(subpath, RUNTIME)) + ')',
                '(allow sysctl-read)',
                '(allow file-read* ' + ' '.join(map(literal, [binary, '/dev/null', '/dev/urandom'])) + ' ' + ' '.join(map(subpath, RUNTIME)) + ')',
                '(allow file-write* ' + ' '.join(map(literal, [stdout, stderr])) + ')',
            ])
            policy_path.write_text(policy)
            outcome['sandboxSha256'] = hashlib.sha256(policy.encode()).hexdigest()
            env = {'PATH': '/usr/bin:/bin', 'HOME': temp, 'TMPDIR': temp,
                   'LANG': 'en_US.UTF-8', 'EDITAC_NATIVE_RUNNER': 'rtf-v1'}
            outcome['environmentKeys'] = sorted(env)
            # An anonymous input FD avoids blocked pipe writes hiding the watchdog.
            with tempfile.TemporaryFile() as source, stdout.open('wb') as out, stderr.open('wb') as err:
                source.write(original)
                source.seek(0)
                # A fresh isolated Python bootstrap sets limits then execs the
                # sandbox in the same PID. No preexec_fn runs after a fork from
                # this potentially multithreaded host. Input is not parsed yet.
                command = [sys.executable, '-I', '-S', str(pathlib.Path(__file__).with_name('bootstrap.py').resolve()),
                           str(output_bytes), str(policy_path), str(binary), mode, *map(str, args)]
                child = subprocess.Popen(command, stdin=source, stdout=out, stderr=err,
                                         cwd=root, env=env)
                outcome.update(executed=1, pid=child.pid)
                last = time.monotonic()
                while child.poll() is None:
                    now = time.monotonic()
                    code = None
                    if (now - start) * 1000 >= wall_ms:
                        code = 'FORMAT_DEADLINE'
                    if cancel is not None and cancel.is_set():
                        code = 'FORMAT_CANCELLED'
                    sample = subprocess.run(['/bin/ps', '-o', 'pid=,rss=', '-p', str(child.pid)+','+str(os.getpid())],
                                            capture_output=True, text=True, timeout=1)
                    samples={int(row.split()[0]):int(row.split()[1])*1024 for row in sample.stdout.splitlines() if len(row.split())==2}
                    if child.pid in samples:
                        rss = samples[child.pid]
                        outcome['peakObservedHostAndWorkerRssBytes']=max(outcome['peakObservedHostAndWorkerRssBytes'],sum(samples.values()))
                        outcome['peakObservedRssBytes'] = max(outcome['peakObservedRssBytes'], rss)
                        outcome['rssSamples'] += 1
                        outcome['maxSampleIntervalMs'] = max(outcome['maxSampleIntervalMs'], (now - last) * 1000)
                        last = now
                        if rss > 256 * 1024 * 1024:
                            code = 'FORMAT_PROCESS_RSS_LIMIT'
                    elif child.poll() is None:
                        code = 'FORMAT_MEMORY_MEASUREMENT_UNAVAILABLE'
                    if code:
                        outcome['code'] = code
                        child.terminate()
                        try:
                            child.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            child.kill()
                        break
                    time.sleep(0.005)
                outcome['exit'] = child.wait(timeout=2)
            raw = stdout.read_bytes()
            error = stderr.read_bytes()
            outcome['stderr'] = error[:4096].decode('utf8', 'replace')
            outcome['serializedBytes'] = len(raw)
            if outcome['code'] is not None:
                outcome['state'] = 'rejected'
            elif outcome['exit'] != 0:
                if b'sandbox-exec:' in error:
                    outcome['code'] = 'FORMAT_ISOLATION_UNAVAILABLE'
                elif outcome['exit'] == -signal.SIGXFSZ:
                    outcome.update(state='rejected', code='FORMAT_OUTPUT_LIMIT')
                elif outcome['exit'] == -signal.SIGXCPU:
                    outcome.update(state='rejected', code='FORMAT_CPU_LIMIT')
                elif b'memory allocation of ' in error:
                    outcome.update(state='rejected', code='FORMAT_HEAP_LIMIT')
                else:
                    outcome.update(state='rejected', code='FORMAT_WORKER_FAILED')
            elif len(raw) > output_bytes:
                outcome.update(state='rejected', code='FORMAT_OUTPUT_LIMIT')
            else:
                try:
                    payload = json.loads(raw)
                except (ValueError, TypeError):
                    raise ValueError('FORMAT_COMPLETION_INVALID')
                if not isinstance(payload, dict):
                    raise ValueError('FORMAT_COMPLETION_INVALID')
                if mode in ('csv-import', 'tsv-import', 'rtf-import', 'rtf-export', 'table-export', 'odt-export', 'docx-export', 'epub-export', 'pdf-export', 'odt-import', 'docx-import'):
                    if payload.get('state') not in ('passed', 'rejected'):
                        raise ValueError('FORMAT_COMPLETION_INVALID')
                    if payload['state'] == 'passed':
                        if (payload.get('originalSha256') != outcome['originalSha256'] or
                            payload.get('profile') != outcome['profile'] or
                            payload.get('hardRustHeapBytes') != RUST_HEAP):
                            raise ValueError('FORMAT_COMPLETION_INVALID')
                        if mode in ('csv-import','tsv-import'):
                            if not _table_completion_valid(payload, original, args):
                                raise ValueError('FORMAT_COMPLETION_INVALID')
                        elif mode in ('odt-import','docx-import'):
                            if not _container_import_completion_valid(payload,original,args):
                                raise ValueError('FORMAT_COMPLETION_INVALID')
                        elif mode == 'rtf-import':
                            if (not all(payload.get(k) for k in ('undo', 'redo', 'reopen')) or
                                hashlib.sha256(bytes(payload.get('checkpoint', []))).hexdigest() != payload.get('checkpointSha256')):
                                raise ValueError('FORMAT_COMPLETION_INVALID')
                        else:
                            if not _export_completion_valid(payload, original, mode == 'table-export', mode == 'odt-export', mode == 'docx-export', mode == 'epub-export', mode == 'pdf-export'):
                                raise ValueError('FORMAT_COMPLETION_INVALID')
                    outcome.update(state=payload['state'], code=payload.get('code'), outputAccepted=payload['state'] == 'passed')
                else:
                    outcome.update(state='probe', outputAccepted=False)
                outcome['result'] = payload
                # Completion is fenced after decoding, including a cancellation
                # that arrived between process exit and accepting its result.
                if (cancel is not None and cancel.is_set()) or (time.monotonic()-start)*1000 >= wall_ms:
                    outcome.update(state='rejected', code='FORMAT_CANCELLED' if cancel is not None and cancel.is_set() else 'FORMAT_DEADLINE', outputAccepted=False)
                    outcome.pop('result', None)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        outcome['code'] = str(error)
        outcome['state'] = 'unavailable'
        outcome['outputAccepted'] = False
        outcome.pop('result', None)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        outcome['childExited'] = child is None or child.poll() is not None
        outcome['durationMs'] = (time.monotonic() - start) * 1000
        outcome['peakHostRssBytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Darwin reports bytes; this profile is Darwin-only. Includes Python
        # startup, binary hashing, input/output buffers and JSON/serialization.
    return Result(outcome, original)
