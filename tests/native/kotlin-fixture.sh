#!/usr/bin/env bash
set -euo pipefail
core_root="$(cd "$(dirname "$0")/../.." && pwd)"
exec python3 "$core_root/tests/native/kotlin-fixture.py" "$@"
