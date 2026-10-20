# Native table policy proof

STB-1.1 adds trusted `NativeSession.setTablePolicy(enabled)` over the existing
`EditService` policy on its worker. Create/open remain table-disabled. This proof
qualifies bounded v1 cell admission; shared v2/structural editing, live native
remote updates and AppKit table editing remain later gates.

The actual SQLite baseline is produced by the unchanged
`native/macos/tests/TablesFixture` factory. Its immutable v1/v2 corpus is setup,
not evidence of native editing. Qualifying edits call generated `NativeSession`
prepare/check/commit/cancel/history methods on the same live Session. The Rust
unit harness also injects real NativeStore quota and lost-ack faults, preserving
the admitted update and exact recovery semantics.

Evidence: `stb-1.1-20261015/delivery.json`, binding and generated-runtime receipts,
raw logs, retained generated consumers, executable binaries and SQLite stores.
Counts: Rust unit 34/34 (including eight actual table cases), affected native
integration 59/59, binding assertions 55/55, Swift semantic 30/30 (three table
cases), instrumented 31/31, unchanged legacy engine 8/8, unchanged previously
admitted generated Session consumer 12/12. All listed qualification suites have
zero failures/skips. Buffer instrumentation is a disposable generated-source
copy; the semantic runtime uses the authoritative unmodified generated bindings.

The first unconfigured broad FFI invocation passed 34 unit and 9 compatibility
cases, then failed two existing JS round-trip cases because
`EDITAC_COMPATIBILITY_OUTPUT` was absent. Its original log is retained; those
cases require their isolated Rust→Node→Rust harness and are not claimed passed.
Full affected WASM/Node qualification remains STB-1.4.

Reproduction (from core, Rust 1.97.1; no providers or credentials):

```sh
cargo test -p editac-ffi --lib --locked --offline
cargo test -p editac-ffi --locked --offline --test native_session --test native_session_commands --test native_session_command_profiles --test native_session_projection --test native_abi
CARGO_NET_OFFLINE=true python3 tests/native/bounded-bindings.py --output <fresh-output>
CARGO_TARGET_DIR="$PWD/target" EDITAC_NATIVE_SESSION_EVIDENCE=<fixture-output> cargo run --manifest-path native/macos/tests/TablesFixture/Cargo.toml --locked --offline
python3 tests/native/session-command-proof/run.py --output <fresh-output> --table-fixture <fixture-output>/manifest.json
python3 tests/native/session-backward.py --output <fresh-backward-output>
```

No macOS consumer source changed. No publication, deployment, integration,
provider, platform, release or performance qualification is claimed.
