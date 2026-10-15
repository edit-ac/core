# STB-1.3 native trusted-host journal qualification

Qualified worker implementation, not main integration, network/encryption,
AppKit editing, collaboration lifecycle, platform, release or performance proof.
Source authority: immutable revision d13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526.

`NativeSession.reservePeerWriter`, `pendingUpdates` and `receivePeer` are thin
serialized adapters over existing SessionStore reservation, the committed Session
outbox, JournalEntry::from_stored and EditService/Session::receive_peer. The
trusted host must authenticate/authorize and admit/decrypt its existing envelope
before ingress. Writer IDs/digests are not credentials. This qualifies the owning
baseline trusted-host contract; the existing security crate offers qualification
probes, not a public production encryption API. No new crypto or transport model
was introduced. STB-1.4 still owns transport/authority/presence/reconnect services.

Two independent SQLite native Sessions restore the same immutable table baseline,
then perform actual generated-client/shared commands. V1/v2 cells and unmerged
v1/v2 structures converge; whole remote table payload and owner are retained.
Actual projection patches and table/paragraph anchor revision changes invalidate
captured targets. Cancelled/stale plans cannot overwrite accepted remote work;
local paragraph undo/redo preserves unrelated remote edits. Reopen retains exact
content and idempotent replay uses the persistent writer reservation.

Preflight rejects malformed/full-scope/foreign-owner/digest/metadata/limit input
before live/store mutation. Existing SQLite unreserved-writer, sequence-gap,
conflicting replay and storage errors retain their recovery freeze semantics.
Readonly/expired *local write* permission does not block host-admitted inbound
work. Default local table policy and old constructors/records/errors are unchanged.
Before-commit quota failure admits no remote entry; lost acknowledgment retains
one durable remote entry for exact recovery/retry. Frozen outbox export denies
publication. A transaction-boundary test blocks actual public ingress while a
concurrent dispose waits; accepted ingress finishes durably and cancelled work
cannot roll it back. Late calls reject after disposal. There is no incoming queue
or callback to cancel in this synchronous adapter.

Final applicable evidence (no failed/ignored/skipped qualification cases):

- Rust: **98 unique tests**: 39 unit (35 unchanged passes from
  `rust-unit-attempt-1.log`, three strengthened remote cases in
  `rust-remote-final.log`, one new ordered-ingress/disposal case in
  `rust-dispose-final.log`) plus 59 affected ABI/Session/command/projection cases
  in `rust-affected.log`. There were 101 actual successful test executions;
  filtered counts 35/38 are explicitly not executed cases.
- Authoritative generated Swift/header/Kotlin: **59/59 binding assertions**,
  rebuilt current SQLite dylib and actual Swift typecheck (`bindings/`).
- Swift: **93 unique generated/instrumented/legacy executions**. Runtime has 36
  unique cases: 32 unchanged from attempt-2 plus four strengthened remote cases
  from attempt-3. Instrumented attempt-3 runs all 37 (1,092 buffer lifts/frees,
  59 foreign handle frees). Attempt-2 supplies eight unchanged legacy engine
  cases, exactly reused in attempt-3. `backward/receipt.json` supplies 12 unchanged
  previously admitted generated Session cases against this rebuilt library.
  Total actual Swift executions are 134 (81 + 41 + 12); reused legacy and repeated
  instrumented cases are not new unique cases. Filtered runtime cases are absent,
  not passes. Exact per-attempt selected IDs and counts are in receipts.
- ABI audit: old Options/Read/Commit bodies and error ordering byte-identical;
  generated declarations add lines only. `abi-audit.json`, Rust ABI unit/integration
  and unchanged generated consumers provide independent evidence.

Preserved unsuccessful/setup evidence: attempt-1 Swift compile caught incorrect
new proof enum-case capitalization (no tests executed); attempt-2 corrected this.
`rust-dispose.log` executed zero tests after a wrong-relative-path shell insertion;
it is not qualification. The corrected implementation/test is the passing
`rust-dispose-final.log`. Exact failed Swift input is retained by its receipt hash.
No semantic acceptance failure remains; prior gates' failed evidence is untouched.

Reproduction uses Rust 1.97.1, Node 24.19.0 in child PATH, locked offline caches,
real generated Swift on macOS aarch64, deterministic fixtures and no providers:

```sh
cargo +1.97.1 test -p editac-ffi --lib --locked --offline
cargo +1.97.1 test -p editac-ffi --locked --offline --test native_session --test native_session_commands --test native_session_command_profiles --test native_session_projection --test native_abi
CARGO_NET_OFFLINE=true python3 tests/native/bounded-bindings.py --output <fresh-bindings>
# Copy that bindings-receipt.json into <fresh-output> before the composed harness.
python3 tests/native/session-command-proof/run.py --output <fresh-output> --table-fixture tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json
python3 tests/native/session-backward.py --output <fresh-backward>
```

`delivery.json` binds owning commits, source envelope, generated/current library,
fixture, retained runtime binaries/stores/logs and compatibility proof by exact
hash. The immutable baseline corpus factory and native/macos consumer source were
not edited. Three preexisting performance/projection changes retain their exact
prior hashes (`preserved-changes.json`). No publication, controller operations,
main integration, paid calls, credentials, live service or provisioning occurred.
