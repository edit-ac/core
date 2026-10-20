# Scoped native presence prerequisite

**STB-1.4-b1 implemented and verified; STB-1.4-b and parent STB-1.4 remain open.**
No full collaboration, encryption/authority, AppKit/IME, platform, performance,
release, main integration or deployment claim follows from this receipt.
Immutable source revision:
`d13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526`.

Source: core `730f44177da1bc8598f614e7908f22171cdfced5`; authoritative contracts:
architecture `325986f202a413642e5243cd4889a4f827d56038`.
`delivery.json` binds the exact source envelope, generated interfaces, retained
native libraries/Rust and Swift binaries, actual stores, fixtures and logs.
The three pre-existing dirty performance/projection files retain their initial
hashes and are excluded from the owned commits. The source envelope identifies
that actual consumed working tree, rather than claiming the commit alone does.

## Implemented boundary

Five additive NativeSession presence methods retain existing records/error tags
and defaults. They reuse the active connection token, exclusive host lease,
Session recovery guard, bounded Transport and existing portable anchor admission.
Core wraps **Yrs Awareness on a clone of the same document handle/store**. It
introduces no semantic replica, transport protocol or awareness state machine.
Pinned awareness bytes are bounded and validated in full before peer application;
a bounded canonical scanner precedes the owning decoder. Participant routing is
a trusted-host responsibility; client IDs are not authentication.

Presence uses a separate bounded queue from durable sync. Local updates coalesce,
50 ms throttling and backpressure retain the newest state, and permanent frame
limits return their precise existing error. Remote anchors resolve against the
actual current shared document. Expiry/leave retain bounded clock tombstones;
detach/reattach/disposal drop the connection's ephemeral state and queues. No
journal, revision, history operation, receipt, timer, callback or IO is introduced.
Read-only local permission remains independent of host-authorized presence.

## Applicable final verification

- `rust-qualified.log`: **118/118** across six actual native Rust suites, zero
  failed/ignored/skipped/filtered. Twelve added cases cover distinct SQLite
  selections and real remote structural changes, deletion/undo, zero durable
  mutation, expiry/renewal/leave/replay, whole-frame atomic admission/capacity,
  bounds/coalescing/backpressure, malformed/cursor/time/scope denial, lease
  revocation/rejoin/late calls/disposal and retained-update recovery for quota
  and lost acknowledgment. Staged input cancellation is shared-boundary proof,
  not native IME execution.
- The Rust batch includes an actual **Node 24.19.0 / y-protocols 1.0.7** awareness
  round trip: native portable selection -> pinned JS oracle -> live native
  Session import/resolution. The oracle's temporary Y.Doc is only a wire oracle;
  it never replaces either live SQLite-backed model or makes semantic edits.
- `swift-qualified/receipt.json`: **105/105** actual executions: 48 semantic,
  49 instrumented and 8 unchanged legacy engine cases. Six generated Swift
  presence cases compose with the existing canonical Session/table/transport
  harness. Buffer instrumentation balances **1,325 lifts/frees**, with 84 foreign
  frees. `backward/receipt.json`: **12/12** unchanged prior generated Session
  consumer/header executions against the exact current library. Total: **117**.
- `bindings-qualified/bindings-receipt.json`: **77/77** interface assertions,
  actual Swift typecheck and authoritative Swift/header/Kotlin generation.
- `abi-audit.json`: **89/89** exact prior public declarations, method checksums
  and header preservation against STB-1.4-a source `2114a3b`.
- `architecture-check.log`: validation plus **14/14** contract tests, zero
  failures/skips. Formatting, source/contract whitespace, two Python harness
  parses and Node syntax checks pass. No paid/live/network/provider tests ran.

Initial passing Rust/Swift phases are retained but not added to final counts.
`check.log` and `check-repair.log` preserve compile failures (unavailable derive,
then a missing argument); the adapter uses no new dependency. `rust-final.log`
preserves **55 passed/1 failed**: the new Node fixture used the promises API with
stdin fd 0, repaired to synchronous fd reading. `rust-repaired.log` preserves
**58 passed/1 failed**: its deletion setup incorrectly treated an undo-split
alias as a deleted source. Shared anchors correctly follow that alias; the final
case uses the actual existing Session Enable(false) owner-deletion command and
undo. These were harness repairs, not grounds to weaken shared anchor behavior.
`library-initial/` retains the initial successful phase library;
`library/` is the final qualified library. Neither relies on a later mutable
`target/debug` artifact. Exact executed Rust test binaries are also retained.

## Reproduce the combined batch

Use pinned Rust 1.97.1 and Node 24.19.0, locked offline caches, and a fresh absolute
`EDITAC_NATIVE_SESSION_EVIDENCE` directory. The canonical fixture factory is
unchanged; `stb-1.1-20261015/table-fixture/manifest.json` is prepared baseline data.

```sh
cargo +1.97.1 test -p editac-ffi --locked --offline --lib --test native_session --test native_session_commands --test native_session_command_profiles --test native_session_projection --test native_abi
CARGO_NET_OFFLINE=true python3 tests/native/bounded-bindings.py --output <bindings>
# Copy <bindings>/bindings-receipt.json into fresh <swift> before the next command.
python3 tests/native/session-command-proof/run.py --output <swift> --table-fixture tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json --host-transport
python3 tests/native/session-backward.py --output <backward>
python3 tests/native/table-session-proof/stb-1.4-b-20261015/audit_abi.py
```

## Remaining original acceptance

STB-1.4-b2 must reuse the existing authority/key admission contracts and complete
remaining document-switch/cancellation/late/reentrant/composition lifecycle proof
with deterministic prepared fixtures, followed by STB-1.4-c full generated-client
capability qualification. The existing security services are under
`crates/editac-security/src/{keys,store,sync}.rs` and their owning prepared tests;
no production cryptographic capability may be inferred from this host lease.
Do not duplicate those state machines or weaken admission. The security crate's
default API remains explicitly unqualified for production encryption.

Original DSK-1.10/1.11/1.15 acceptance, STB-1.5 atomic content, STB-1.6 final artifact
qualification and MONITOR ONLY STB-1.7 remain open. Native/macos consumer source,
roadmaps, shared-resource loaders and unrelated private performance files were
not changed. No publication, spending, external messages, controller actions or
main integration occurred. No task browser or temporary server was started.
