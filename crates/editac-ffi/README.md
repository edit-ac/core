# Native preparation bridge

The authoritative contract is [native-abi.md](../../../architecture/specs/native-abi.md). This crate compiles the existing semantic bridge source and owns one serial Rust executor per opaque handle. Whole command batches return detached patches; checkpoint/update buffers are owned. It is not a mobile SDK.

From the core repository:

```sh
cargo +1.97.1 test -p editac-ffi --test native_abi --locked
cargo +1.97.1 test -p editac-ffi --locked
python3 tests/native/bounded-bindings.py --output ../architecture/evidence/native-preparation/nat-1.2-20261013
```

The generator is the same exactly pinned UniFFI dependency as the runtime. The harness writes both language outputs to `crates/editac-ffi/generated/`, records native build/generator/interface logs and hashes in its output directory, and rejects missing signatures, different offset/buffer mappings or leaked engine types. Generated host execution and real text controls are later roadmap parents. The fixed corpus is `tests/native/fixtures/bounded-abi.json`; it includes an emoji and combining mark to distinguish UTF-16 offsets from bytes and scalar counts.

Swift/Kotlin outputs require their generated foreign-reference teardown plus explicit `dispose()` for prompt worker shutdown. No callback interface exists. Do not issue one FFI call per character or treat detached snapshots as a writable document.

`NativeSession` also exposes on-demand immutable review. Capture a semantic revision
with `captureReviewRevision` using the acknowledged token from `read`; retain the
complete returned identity/hash receipt for `readReviewRevision` and
`compareReviewRevisions`. Capture uses the actual Session projection and the shared
bounded `HistoryStore`. Read bytes retain the canonical semantic encoding prefix.
Comparison returns the existing portable ChangeModel with unknown attribution.
`validateChangeModel` admits exact-source/projected wire and complete semantic
models through the same Rust decoder used by other clients.

The review companion is process-local; disposal or reopening returns missing for
old handles. FIFO pruning, unavailable key profiles and incompatible schema/profile
are explicit results. Key-profile labels do not authorize or encrypt access. Review
does not change the live replica, undo groups, SQLite journal or projection queue.
See the shared [ABI contract](../../../architecture/specs/native-abi.md) for bounds.

Focused deterministic qualification (from core):

```sh
cargo +1.97.1 test -p editac-ffi --test native_session_review --locked
python3 tests/native/bounded-bindings.py --output architecture-results/review-bindings
python3 tests/native/session-review.py --output architecture-results/review-swift --bindings architecture-results/review-bindings/bindings-receipt.json
```
