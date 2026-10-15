# STB-1.4 shared collaboration qualification

Worker delivery only; not main-integrated, deployed, production encrypted or an
original native UI/IME acceptance claim. This closes the shared-port STB-1.4
criteria using the current actual Session library and generated Swift on macOS
arm64, with distinct SQLite-backed NativeSession peers. Original DSK-1.10,
DSK-1.11 and DSK-1.15 acceptance remains open. Atomic content STB-1.5, final
qualification STB-1.6 and MONITOR ONLY STB-1.7 remain open.

## Implementation and trust boundary

Core source `e4d82b718723c6aacabd96e338053b0c7aec5bf9`; architecture contracts
`e4c132c9505c30ba1b79dee05c46cf212b283550`. The b2 delivery implements a local
qualification host and lifecycle cases around the already owned native ports;
no additional production semantic/security adapter proved necessary. The new
`editac-security/examples/native-host-admission.rs` directly includes the SAME
owning prepared KeySession, MLS Admission/EncryptedClient and ciphertext SQLite
relay as the existing security qualification. It is absent from the default
security library and is not an exported API. Prepared authority decisions and
fresh key acquisition/context checks are independent gates. The acquired host key
is not an MLS epoch exporter; freshly prepared MLS membership is separately
established by the existing fixture. The fixture is not a production identity,
key-wrapping, encrypted local-store or fresh-group provisioning qualification.

The generated Swift host runs that retained executable locally, admits exact
committed peer journal entries through actual MLS, and only then calls the
existing native host-ingress adapter. Denials never enter semantic mutation.
Corrupt ciphertext fails actual MLS authentication and retires that client;
subsequent admission remains locked. A ciphertext relay receipt never prunes the
native application outbox. Native ingress still enforces actual worker generation,
exclusive lease, reserved writer, full document identity, semantic admission and
SQLite durability/recovery. No new wire/security/state machine or live service.

## Original STB-1.4 criterion matrix

| Original criterion | Current actual proof |
| --- | --- |
| Existing Session/SyncService/journal; two distinct SQLite peers and convergence | Current Rust native host tests; generated `host-transport-distinct-sqlite-*` plus `authority-key-real-mls-native-distinct-sqlite-denial-revoke-rejoin-receipts`; exact independent paths and admitted cell payload |
| Disconnect/reconnect, durable receipt/ack, exact replay | Current host transport/page tests, actual generated reconnect/receipt cases and b2 rejoin/idempotent replay; pending work retained until exact native application receipt |
| Prepared authority/key admission; expiry/revocation/rejoin | b2 generated authority case: independent authority/Locked/Revoked/Unavailable/foreign key-context denial, five fresh acquisition attempts at first success, actual MLS admission; detach/rejoin changes token; exclusive lease rejection at expiry; owning `key_lifecycle` and `encrypted_sync` regression suites |
| Authentication failure and key/epoch/membership guards | b2 generated corruption/retirement case; owning prepared security suites exercise context, epochs, reader/writer membership, protected store and no fallback. This is prepared security proof, not a production encrypted profile |
| Scoped ephemeral remote selections | Current actual distinct-store Rust/generated presence cases, including pinned Node awareness roundtrip, anchor resolution after remote structure/deletion/undo, tombstones, no durable presence mutation |
| Document switch, detach/cancel/dispose and late events | New Rust and generated `lifecycle-document-switch-cancel-queued-input-and-late-host-events`: explicit cancel/detach/dispose, genuinely different new document, rejected old handles/tokens/foreign frames, unchanged replacement model; current canonical concurrent cancellation/disposal cases |
| Reentrant host events | New Rust/generated host-completion cases read/revoke/rejoin immediately after durable ingress returns, then deny old generation/replay idempotently. No foreign callbacks are installed by the native adapter, so there is no internal callback reentrancy path. Concurrent worker-entry ownership is covered by current canonical Session cases |
| Composition overlap at owned shared boundary | New Rust/generated remote-overlapping-staged-input cases: remote SAME-paragraph insertion while local input is prepared, stale commit rejection, explicit cancel/current-revision reprepare, real local commit/undo/redo preserving remote text. Existing presence case never publishes staged input. Native UI/IME execution is parallel-owned and remains open |
| Invalid/oversize/wrong document/stale identity and denial | Current Rust/generated host/presence suites and b2 document-switch/authority cases; invalid attach preserves connection, stale tokens cannot affect replacements, bounds/scope failures precede mutation |
| Accepted-update retention, freeze, exact recovery/publication | Current native quota/lost-ack host and presence recovery cases; actual SQLite transactions, retained update/read/export, no publication during recovery and idempotent retry. Same production ports/source as b2; security prepared-store regression failures also remain fail-closed |
| Generated Swift, truthful capability and backwards ABI | Current regenerated Swift/header/Kotlin and actual Swift executions, unchanged old generated Session and legacy engine consumers, exact prior record/method/header ABI audit. Host transport is a host port, not an editor module; command catalog/default policy and production crypto availability remain unchanged. No full native presenter capability is advertised |

## Final checks and retained failures

- `rust-repaired.log`: **121/121**, six current native Rust suites (62 library,
  8 ABI, 9 Session, 4 profiles, 25 commands, 13 projection), zero failed,
  ignored, measured or filtered tests. Three new lifecycle cases.
- `security.log`: **52/52**, actual owning encrypted_sync/key_lifecycle/
  protected_store suites (17/20/15), zero failed/ignored/filtered.
- `swift/receipt.json`: **115/115** actual executions: 53 generated semantic,
  54 instrumented and 8 unchanged legacy engine cases. Five new b2 generated
  cases. Buffers balance **1,430 lifts/frees**, 96 foreign frees.
  `backward/receipt.json`: **12/12** unchanged prior generated Session consumer
  executions against the same current library. Combined Swift: **127**.
- `bindings/bindings-receipt.json`: **77/77**, authoritative Swift/header/Kotlin
  generation and actual Swift typecheck. `abi-audit.json`: **96/96** prior public
  records, method checksums and prior header lines, baseline `730f441`.
- `architecture-check.log`: roadmap/editing-suite validation and **14/14**
  contract tests, zero failures/skips. Changed Rust formatting, source/contract
  whitespace and Python parse checks pass. Total final executed checks: **487**.

Initial failure evidence is retained and excluded from final counts:
`host-fixture-build.log` failed compilation because the SQLite fixture expected
`&Path`, fixed with the explicit Path conversion. `swift/attempt-1` failed
compilation on byte arrays where generated bindings require Data, fixed with Data
construction; no semantic Swift runtime executed in that attempt. `rust.log`
executed 62 library tests: 61 passed/1 failed, zero ignored/filtered; five requested
integration suites were not reached. The new assertion incorrectly expected an
empty outbox after remote admission. The existing forwarding contract correctly
retains the accepted remote entry. The repaired assertion proves one exact
checksum entry and no staged-input publication. `rust-repaired.log` then executes
all six requested suites. Failed logs/stores remain; only the final executed Rust
binaries are retained (the failed test binary was rebuilt at the same Cargo path).
There were no final skips, interrupted checks or provider/network calls.

## Artifacts and reproduction

`delivery.json`, `source-envelope.json`, `artifact-envelope.json` bind exact
source/dirty-source, generated declarations, current library, executed Rust/Swift
and host-fixture binaries, corpus/MLS fixtures, SQLite outputs, tool versions and
logs. The consumed dylib is retained in `library/`, not a later mutable target.
Raw fixture replies/ciphertext relays and zero-length stderr files are under the
semantic/instrumented Swift stores. The new helper processes close stdin, exit
and are joined on success/failure. No browser or temporary server was started.

Use Rust 1.97.1, Node 24.19.0 and locked offline caches. From core:

```sh
cargo +1.97.1 build -p editac-security --example native-host-admission --locked --offline
# Fresh absolute EDITAC_NATIVE_SESSION_EVIDENCE, pinned Node on PATH:
cargo +1.97.1 test -p editac-ffi --locked --offline --lib --test native_session --test native_session_commands --test native_session_command_profiles --test native_session_projection --test native_abi
cargo +1.97.1 test -p editac-security --locked --offline --test key_lifecycle --test encrypted_sync --test protected_store
CARGO_NET_OFFLINE=true python3 tests/native/bounded-bindings.py --output <bindings>
# Copy bindings-receipt.json into fresh <swift> first; retain the current helper.
python3 tests/native/session-command-proof/run.py --output <swift> --table-fixture tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json --host-transport --authority-fixture <retained-native-host-admission>
python3 tests/native/session-backward.py --output <backward>
python3 tests/native/table-session-proof/stb-1.4-b2-20261015/audit_abi.py
```

No native/macos source, original roadmap, private performance/projection work,
shared-resource loader, production crypto API, source history or credentials were
changed. Three unrelated dirty source hashes remain identical. `hygiene.json`
lists nine current-session inactive incremental cache directories removed (about
336 MiB allocated); all qualification binaries/stores/logs remain. Data volume
free after cleanup: **135,932,669,952 bytes**. No unrelated process was stopped.
