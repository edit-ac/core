#!/usr/bin/env bash
# Run from core; isolate this independent lockfile's artifacts from workspace builds.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
export CARGO_TARGET_DIR="$root/.artifacts/highlight-engine-effects-target"
exec cargo test --manifest-path "$root/tests/highlight-engine-effects/Cargo.toml" --locked --lib -- --nocapture
