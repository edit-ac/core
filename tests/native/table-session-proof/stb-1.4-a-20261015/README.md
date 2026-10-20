# STB-1.4-a native host transport prerequisite

Implemented and verified prerequisite of **open STB-1.4**. This is not full
collaboration, encrypted transport, native UI/input/selection, platform, release,
main integration or deployment qualification. Source authority is immutable
revision `d13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526`.

Core source: `2114a3bdda7166eec7b9ee1d03a202dfd86a5f51`.
Authoritative contract: architecture `0a2a91eb98bffedbd19ddad5db9c18a5eda6a9d8`.
`delivery.json` binds exact tested worktree source, generated artifacts, retained
library, fixtures, executables, stores and logs. Three pre-existing dirty
performance/projection files are included in the consumed source envelope and
preserved byte-for-byte; they were not staged or claimed as this delivery.

## Delivered boundary

`attachHostTransport` explicitly grants an exclusive host-clock lease on the
existing Session. Fresh worker/connection tokens protect detach, flush, drain,
ingress and receipts from stale events and other owners. Invalid attachments
preserve the current connection. The copied, bounded outbound queue reuses the
existing `PreparedTransport` implementation as the actual injected Transport;
it is not a mock document, relay service or second synchronization state machine.
No callback, timer, socket, credential discovery or live service is installed.

`flushHostTransport` forwards to existing Session y-protocols framing.
`receiveHostPeer` forwards to the STB-1.3 actual Session/SQLite journal boundary,
after trusted host authentication/admission and active lease checks. Exact writer
reservation, schema/identity/checksum/admission and storage semantics remain
owned by Session. The host still authenticates participants; writer IDs and
checksums are not credentials. This prerequisite does not expose unauthenticated
network input or claim an encrypted profile or authority/key implementation.

`acceptHostReceipt` uses the existing negotiated application receipt and atomic
SQLite receipt path. Send/drain is never an acknowledgment. Backpressure keeps
the queued prefix and durable outbox; disconnect drops transient frames only.
Readonly/expired local permission and host transport authorization remain
independent. Recovery freezes publication, drain, ingress and receipts; append
and receipt before-commit/lost-ack failures recover exactly and idempotently.

An additive `Session.flush_pending_page` and thin EditService/native forwarding
allow an exact retained pending-identity cursor and bounded page limit. Hosts
can drain a backlog larger than the queue without receipt capability. Cursors
never prune or acknowledge; unknown/acknowledged cursors reject before sending.
Existing whole-outbox flush behavior is preserved through that same code path.

## Applicable final verification

- **189 Rust tests**: 106 native/ABI/command/projection/unit cases in
  `rust-committed.log`; 83 owning Session lifecycle/ports/EditService cases in
  `rust-session-configured.log`. Zero final failed, ignored, skipped or filtered.
  Eight new native tests cover distinct SQLite v1/v2 cell/structural transport,
  exact durable receipts/replay/reopen, lease denial/rejoin/local permission,
  scope/size/cursor checks, backpressure and actual transaction faults/recovery.
- **70 binding assertions**, actual generated Swift typecheck and regenerated
  authoritative Swift/header/Kotlin: `bindings-committed/`.
- **78 exact ABI preservation assertions**: prior public record/error layouts,
  generated method checksums and existing C declarations, `abi-audit.json`.
- **105 Swift executions**: `committed-swift/receipt.json` contains 42 semantic,
  43 buffer-instrumented and 8 unchanged legacy-engine cases; the unchanged
  prior generated Session/header consumer passes 12/12 in
  `backward-committed/receipt.json`. All run against the exact retained current
  library, not substituted older declarations. Six added transport cases include
  distinct-store convergence, leased ingress, receipt/reconnect/reopen and a
  three-entry backlog through a one-frame queue with no receipts.
- Architecture checks pass, including **14 contract tests**;
  `architecture-check.log`. Owned source whitespace and Rust formatting pass.
  Generated snapshots retain the authoritative generator's exact formatting.

The source comment cleanup after the first proof changed the debug library
hash. `comment-build.log` and `bindings-committed/` rebuild the committed source;
`committed-swift/`, `backward-committed/` and `rust-committed.log` are the applicable
replacement proof. Earlier successful attempts remain retained but are not added
to final counts. The first broad Session attempt had **22 passed / 4 failed**
because `EDITAC_SERVICE_EVIDENCE` was absent, aborting before the other suites.
`rust-session-affected.log` retains those failures. Explicit task-owned service
and lifecycle evidence paths repair the harness configuration; the complete
configured 83-test run then passes. Initial formatting command path errors are
retained in `fmt-attempt-*.log`; final formatting checks pass. No failed or
unexecuted case is counted as a qualification pass.

## Reproduction

Use pinned Rust 1.97.1 and Node 24.19.0 in child PATH, locked offline caches and
fresh absolute task-owned directories for `EDITAC_NATIVE_SESSION_EVIDENCE`,
`EDITAC_SERVICE_EVIDENCE` and `EDITAC_LIFECYCLE_EVIDENCE`.

```sh
cargo +1.97.1 test -p editac-ffi --locked --offline --lib --test native_session --test native_session_commands --test native_session_command_profiles --test native_session_projection --test native_abi
cargo +1.97.1 test -p editac-session --features native-store --locked --offline --test lifecycle --test ports --test edit_service
CARGO_NET_OFFLINE=true python3 tests/native/bounded-bindings.py --output <bindings>
# Copy its bindings-receipt.json into a fresh <swift> output directory.
python3 tests/native/session-command-proof/run.py --output <swift> --table-fixture tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json --host-transport
python3 tests/native/session-backward.py --output <backward>
python3 tests/native/table-session-proof/stb-1.4-a-20261015/audit_abi.py
```

`library/libeditac_ffi.dylib` retains the exact qualified artifact. For standalone
replay of retained Swift binaries, explicitly select that library directory with
`DYLD_LIBRARY_PATH`, provide a fresh store directory and the recorded fixture
argument. Never infer applicability from a later overwritten `target/debug` file.

## Remaining original acceptance

STB-1.4-b still owns scoped ephemeral presence/portable remote anchors, remaining
authority/key/authorization contract integration, document switching,
cancellation/late/reentrant lifecycle and composition overlap. STB-1.4-c owns full
generated-client collaboration/capability qualification and backward proof for
that complete surface. No full collaboration capability is advertised here.
Original native DSK-1.10/1.11/1.15 remain open; native/macos consumers and all
source roadmaps are untouched. No publication, paid inference, external messages,
controller operations or main integration occurred. No task browsers or temporary
servers were started. `hygiene.json` records retained artifacts and free space.
