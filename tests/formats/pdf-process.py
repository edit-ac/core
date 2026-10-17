#!/usr/bin/env python3
"""macOS candidate-only launcher. No download, shell, ambient credentials or
production format route. Exact allowlisted executable, fonts and job directory.
RSS is an observed watchdog with recorded sample latency, not an allocation-time
hard limit. Unavailable enforcement fails closed; partial output is removed.
"""
import hashlib, json, os, pathlib, platform, resource, signal, subprocess, sys, time


def run(config):
    root = pathlib.Path(config['root']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    result_path = root / 'process.json'
    output = root / 'output.pdf'
    stdout = root / 'stdout.log'
    stderr = root / 'stderr.log'
    receipt = dict(schemaVersion=1, state='unavailable', code=None, executed=0,
                   peakObservedRssBytes=0, rssSamples=0, maxSampleIntervalMs=0,
                   resourceModel='RLIMIT_CPU/FSIZE/NOFILE; wall cancellation; observed-RSS watchdog',
                   target=platform.platform(), mode=config.get('mode'))
    child = None
    owns_output = False
    start = time.monotonic()
    try:
        if output.exists():
            raise ValueError('PDF_OUTPUT_TARGET_OCCUPIED')
        if platform.system() != 'Darwin' or platform.machine() != 'arm64':
            raise ValueError('PDF_TARGET_UNAVAILABLE')
        if config.get('isolation', True) is not True or not pathlib.Path('/usr/bin/sandbox-exec').is_file():
            raise ValueError('PDF_ISOLATION_UNAVAILABLE')
        limits = config.get('limits', {})
        wall = limits.get('wallMs', 5000)
        rss = limits.get('rssBytes', 512 * 1024 * 1024)
        out_limit = limits.get('outputBytes', 4 * 1024 * 1024)
        if not (0 < wall <= 5000 and 0 < rss <= 512 * 1024 * 1024 and 0 < out_limit <= 4 * 1024 * 1024):
            raise ValueError('PDF_RESOURCE_PROFILE_UNAVAILABLE')
        binary = pathlib.Path(config['binary']).resolve()
        if hashlib.sha256(binary.read_bytes()).hexdigest() != config['binarySha256']:
            raise ValueError('PDF_ENGINE_UNAVAILABLE')
        mode = config.get('mode', 'generate')
        fonts = pathlib.Path(config['fonts']).resolve()
        if mode == 'generate':
            manifest = json.loads(pathlib.Path(config['fontManifest']).read_text())
            for name, info in manifest['files'].items():
                if not name.endswith('.ttf'):
                    continue
                p = fonts / name
                if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != info['sha256']:
                    raise ValueError('PDF_FONT_UNAVAILABLE')
            args = ['generate', str(fonts), str(output)]
        elif mode in ('read', 'write'):
            args = [mode, config['attemptPath']]
        elif mode == 'output':
            args = [mode, str(output)]
        elif mode in ('network', 'child', 'spin', 'allocate'):
            args = [mode]
        else:
            raise ValueError('PDF_PROFILE_UNAVAILABLE')
        # Escape sandbox strings with JSON's strict string encoding. No shell.
        literal = lambda p: '(literal ' + json.dumps(str(p)) + ')'
        subpath = lambda p: '(subpath ' + json.dumps(str(p)) + ')'
        runtime_paths = ['/usr/lib', '/System/Library/dyld',
                         '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld',
                         '/System/Volumes/Preboot/Cryptexes/OS/usr/lib',
                         '/System/Cryptexes/OS/System/Library/dyld',
                         '/System/Cryptexes/OS/usr/lib']
        policy = '\n'.join([
            '(version 1)', '(deny default)',
            # macOS 26 dyld/libignition opens / as an openat root, stats
            # Cryptex ancestors and checks code signatures before main().
            # Match the OS dyld-support rules narrowly to these runtime paths.
            '(allow file-read* file-test-existence (literal "/") ' +
            ' '.join('(path-ancestors ' + json.dumps(p) + ')' for p in runtime_paths) + ')',
            '(allow syscall-unix (syscall-number SYS___mac_syscall SYS_getfsstat SYS_getfsstat64 SYS_map_with_linking_np SYS_open SYS_openat SYS_fstatat SYS_fstatat64 SYS_dup))',
            '(allow system-fcntl (fcntl-command F_ADDFILESIGS_RETURN F_CHECK_LV F_GETPATH))',
            '(with-filter (mac-policy-name "Sandbox") (allow system-mac-syscall (mac-syscall-number 2)))',
            '(allow process-exec ' + literal(binary) + ')',
            '(allow file-map-executable ' + literal(binary) + ' ' +
            ' '.join(map(subpath, runtime_paths)) + ')',
            '(allow sysctl-read)',
            '(allow file-read* ' + ' '.join(map(literal, [binary, '/dev/null', '/dev/urandom'])) +
            ' ' + ' '.join(map(subpath, [root, fonts] + runtime_paths)) + ')',
            '(allow file-write* ' + ' '.join(map(literal, [output, stdout, stderr])) + ')',
        ])
        (root / 'sandbox.sb').write_text(policy)
        def set_limits():
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
            resource.setrlimit(resource.RLIMIT_FSIZE, (out_limit, out_limit))
            resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        command = ['/usr/bin/sandbox-exec', '-f', str(root / 'sandbox.sb'), str(binary)] + args
        receipt['command'] = command
        # No inherited provider credentials, font paths, package paths or proxies.
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root), 'LANG': 'en_US.UTF-8'}
        receipt['environmentKeys'] = sorted(env)
        with stdout.open('wb') as out, stderr.open('wb') as err:
            child = subprocess.Popen(command, cwd=root, env=env, stdout=out, stderr=err,
                                     preexec_fn=set_limits)
            owns_output = True
            receipt['pid'] = child.pid
            receipt['executed'] = 1
            last = time.monotonic()
            while child.poll() is None:
                now = time.monotonic()
                elapsed = (now - start) * 1000
                code = None
                if elapsed > wall:
                    code = 'PDF_DEADLINE'
                if config.get('cancelAfterMs') is not None and elapsed >= config['cancelAfterMs']:
                    code = 'PDF_CANCELLED'
                # child is the exact process created here. Never signal a name or group.
                sample = subprocess.run(['/bin/ps', '-o', 'rss=', '-p', str(child.pid)],
                                        capture_output=True, text=True, timeout=1)
                if sample.stdout.strip():
                    observed = int(sample.stdout.strip()) * 1024
                    receipt['rssSamples'] += 1
                    receipt['peakObservedRssBytes'] = max(receipt['peakObservedRssBytes'], observed)
                    receipt['maxSampleIntervalMs'] = max(receipt['maxSampleIntervalMs'], (now-last)*1000)
                    last = now
                    if observed > rss:
                        code = 'PDF_MEMORY_LIMIT'
                elif child.poll() is None:
                    code = 'PDF_MEMORY_MEASUREMENT_UNAVAILABLE'
                if code:
                    child.kill()
                    receipt['code'] = code
                    break
                time.sleep(0.01)
            receipt['exit'] = child.wait(timeout=2)
        if receipt['code'] is None:
            if receipt['exit'] == 0 and mode == 'generate' and output.is_file():
                if output.stat().st_size > out_limit:
                    raise ValueError('PDF_OUTPUT_LIMIT')
                receipt.update(state='passed', outputBytes=output.stat().st_size,
                               outputSha256=hashlib.sha256(output.read_bytes()).hexdigest())
            else:
                if receipt['exit'] == 71 and 'sandbox-exec:' in stderr.read_text():
                    receipt['code'] = 'PDF_ISOLATION_UNAVAILABLE'
                    receipt['state'] = 'unavailable'
                else:
                    receipt['code'] = 'PDF_OUTPUT_LIMIT' if receipt['exit'] == -signal.SIGXFSZ else 'PDF_PROCESS_REJECTED'
                    receipt['state'] = 'rejected'
        else:
            receipt['state'] = 'rejected'
    except Exception as error:
        receipt['code'] = str(error)
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=2)
        if receipt['state'] != 'passed' and owns_output:
            output.unlink(missing_ok=True)
        receipt['durationMs'] = (time.monotonic() - start) * 1000
        receipt['outputExists'] = output.exists()
        receipt['childExited'] = child is None or child.poll() is not None
        result_path.write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    r = run(json.loads(pathlib.Path(sys.argv[1]).read_text()))
    print(json.dumps({k: r[k] for k in ('state', 'code', 'executed', 'childExited')}))
