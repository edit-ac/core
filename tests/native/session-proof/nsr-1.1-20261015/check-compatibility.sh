#!/bin/bash
set -euo pipefail
export PATH=/Users/bpstr/.nvm/versions/node/v24.19.0/bin:/Users/bpstr/.cargo/bin:$PATH
export RUSTUP_TOOLCHAIN=1.97.1
export EDITAC_COMPATIBILITY_OUTPUT=/Users/bpstr/Github/edit-ac-parallel-clients/core/.artifacts/nsr-1.1-20261015/compatibility
mkdir -p "$EDITAC_COMPATIBILITY_OUTPUT"
cargo test -p editac-ffi --test architecture_compatibility --locked --offline -- --skip public_js_checkpoint_returns_to_native_and_public_rust_with_unknown_data > "$EDITAC_COMPATIBILITY_OUTPUT/rust-outbound.log" 2>&1
node .artifacts/nsr-1.1-20261015/compatibility-roundtrip.mjs > "$EDITAC_COMPATIBILITY_OUTPUT/js.log" 2>&1
cargo test -p editac-ffi --test architecture_compatibility --locked --offline public_js_checkpoint_returns_to_native_and_public_rust_with_unknown_data > "$EDITAC_COMPATIBILITY_OUTPUT/rust-return.log" 2>&1
