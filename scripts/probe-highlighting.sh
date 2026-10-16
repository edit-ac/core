#!/usr/bin/env bash
# Run from core with the pinned Rust/Node tools on PATH and an absolute, owned output.
set -euo pipefail
: "${EDITAC_HIGHLIGHT_EVIDENCE:?set an absolute worktree-owned evidence directory}"
case "$EDITAC_HIGHLIGHT_EVIDENCE" in /*) ;; *) echo 'evidence path must be absolute' >&2; exit 2;; esac
if [ -e "$EDITAC_HIGHLIGHT_EVIDENCE" ]; then
  echo "use a new evidence directory to preserve prior failures" >&2; exit 2
fi
mkdir -p "$EDITAC_HIGHLIGHT_EVIDENCE"
cargo test -p editac-highlighting --test highlight_probe --locked -- --nocapture --test-threads=1 > "$EDITAC_HIGHLIGHT_EVIDENCE/native.log" 2>&1
cargo check -p editac-highlighting --target wasm32-unknown-unknown --locked > "$EDITAC_HIGHLIGHT_EVIDENCE/wasm-check.log" 2>&1
cargo build -p editac-highlighting --release --target wasm32-unknown-unknown --features probe-wasm --locked > "$EDITAC_HIGHLIGHT_EVIDENCE/wasm-build.log" 2>&1
wasm-bindgen target/wasm32-unknown-unknown/release/editac_highlighting.wasm --target nodejs --out-dir "$EDITAC_HIGHLIGHT_EVIDENCE/wasm" > "$EDITAC_HIGHLIGHT_EVIDENCE/wasm-bindgen.log" 2>&1
# The sibling architecture package uses ESM; wasm-bindgen's nodejs glue uses CommonJS.
printf '%s\n' '{"private":true,"type":"commonjs"}' > "$EDITAC_HIGHLIGHT_EVIDENCE/wasm/package.json"
node --test tests/highlight-wasm-probe.test.mjs > "$EDITAC_HIGHLIGHT_EVIDENCE/wasm-runtime.log" 2>&1
cargo run -p editac-highlighting --example grammar_inventory --locked > "$EDITAC_HIGHLIGHT_EVIDENCE/grammar-inventory.json" 2> "$EDITAC_HIGHLIGHT_EVIDENCE/grammar-inventory.log"
printf '%s\n' 'Native and WASM probes passed; inspect nonzero case counts and preserve logs.'
