"""Trusted minimal launcher; consumes no document bytes before OS isolation."""
import os
import resource
import signal
import sys

if len(sys.argv) < 5:
    raise SystemExit('FORMAT_ISOLATION_UNAVAILABLE')
output_bytes = int(sys.argv[1])
if not 0 < output_bytes <= 4 * 1024 * 1024:
    raise SystemExit('FORMAT_RESOURCE_PROFILE_UNAVAILABLE')
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_CPU, (1, 2))
resource.setrlimit(resource.RLIMIT_FSIZE, (output_bytes, output_bytes))
resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
# Python ignores these on startup. Restore the worker's native resource signals
# before exec so exhaustion cannot turn into a partial-success stdout stream.
signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
sandbox = '/usr/bin/sandbox-exec'
os.execve(sandbox, [sandbox, '-f', sys.argv[2], *sys.argv[3:]], dict(os.environ))
