# Optional security qualification

SEC-1.7 adds prepared MLS membership commits in `src/membership.rs` and the
canonical `tests/rotation.rs`. A pinned membership authority can remove members
or rotate the epoch; ordinary writers cannot authorize membership changes.
Remaining clients authenticate exact removal intent before merging the MLS
commit. Removed clients become inactive; already acquired plaintext is not
claimed erased. Commit packets use the existing ciphertext relay and receipts.

Old pending work remains in the protected Session journal/outbox and exact
ciphertext mapping. Rotation quarantines it and freezes outbound publication,
including fresh checkpoints, until a separate explicit host recovery workflow
rebases it. This adapter's recovery policy is retain-only: no automatic reseal,
discard, plaintext export or key deletion; full authorized exports are SEC-1.8.
Run `cargo test -p editac-security --test rotation --locked`. See sibling
`architecture/evidence/membership.md` for scope and limits. No production
identity, durable MLS resume/rejoin, rollback freshness or independent review
qualification is added.

SEC-1.6 adds `src/sync.rs` and canonical `tests/encrypted_sync.rs`. It composes
real MLS, protected SQLite session stores and an opaque persistent relay for
encrypted bootstrap and offline convergence. Exact profile negotiation fails
closed. Ciphertext receipts bind scope and bytes; they never become plaintext
`DurableReceipt`s or prune the session outbox. Retry reuses retained ciphertext;
restored senders remain locked. Run `cargo test -p editac-security --test
encrypted_sync --locked`. See sibling `architecture/evidence/encrypted-sync.md`
for limits and distinct host-authentication, rejoin, platform and review gaps.
The adapter remains absent from production builds.

SEC-1.5 adds `src/store.rs`, an actual session `LocalStore` wrapper qualified over
standard age files, protected durable `SessionStore` writer reservations and a real SQLite WAL ciphertext host (`src/store_native.rs`).
Run `cargo test -p editac-security --test protected_store --locked`. The harness
covers protected creation, journal/checkpoint/outbox recovery, key failures,
tamper/context/size rejection, lost acknowledgements and abrupt process death
before/after commits. Its public disposable keys and qualification KDF settings
must never be used for actual content. Acknowledged document data can recover;
restoring it never resumes an old MLS sender.

Native and asynchronous browser transaction contracts keep plaintext out of host
storage. `examples/check-protected-store-ports.rs` is a WASM compile probe, not
IndexedDB runtime evidence. These modules remain absent from production builds;
see sibling `architecture/evidence/protected-store.md` for format, durability,
freshness, resource limits and platform/review obligations.

SEC-1.4 adds prepared host-key ports in `src/keys.rs`, included only by
`tests/key_lifecycle.rs`. Run `cargo test -p editac-security --test key_lifecycle
--locked`. The provider owns authenticated wrapping, unlock, recovery and
retention; scoped decoded buffers zeroize on drop. The deterministic provider
uses opaque lookup handles, not a cipher. See the sibling architecture
`evidence/key-lifecycle.md` for cleanup ownership, failure states and limits.
No OS/browser keystore or production encryption is qualified by these tests.

This unpublishable crate holds SEC-1.2 dependency probes and SEC-1.3 prepared admission mechanics. Default features are empty and the semantic engine does not depend on it. The private `protocol-probe` module type-checks OpenMLS APIs. `src/envelope.rs` is included directly by the prepared integration harness; it is absent from production builds. No production encryption API is exposed.

SEC-1.3 uses real MLS private messages and signature-key-pinned writer policy, authenticates document/document epoch/schema/key epoch/operation context, bounds inputs and operation sets, and returns plaintext only after admission. Membership messages never merge through this path. Semantic validation and durable application acknowledgement remain host/store obligations. See `architecture/evidence/envelope-admission.md` in the sibling architecture repository for fixture provenance, exact limits and remaining gates.

Run its canonical check from core:

```sh
cargo test -p editac-security --test envelopes --locked
```

The committed fixture snapshots contain deliberately public disposable secrets for one prepared MLS group and an unrelated group with matching public identities. Tests load fixed snapshots, use fixed Ed25519 keys and a seeded ChaCha20 application RNG, and assert byte-reproducible application messages. They do not bootstrap groups or record fixtures automatically. The example `prepare-envelope-fixtures` is an explicit offline maintenance utility requiring an output directory; HPKE bootstrap entropy is captured once in the snapshots. Never use these identities, providers or snapshots for real content.

Fresh prepared state is a harness trust root, not evidence of host freshness. Every restored session locks sending and receiving unconditionally, has no unlock/resume operation, and requires a future authorized fresh-sender rejoin. Memory storage does not provide transactional persistence. The admission object is neither clonable nor serializable; snapshot/fork/crash detection, protected storage, identity binding, cleanup, rotation and independent review must be qualified at their owning gates before a host API can exist.

Run from the core root with the pinned Node/Rust toolchains:

```sh
node --test scripts/check-security-targets.test.mjs scripts/check-security-dependencies.test.mjs
node scripts/check-security-targets.mjs --all
node scripts/check-security-dependencies.mjs --evidence .artifacts/security-dependencies
```

The target manifest is `scripts/security-targets.json`. Missing targets fail qualification. rlib compilation is separate from linking, runtime/RNG, storage, platform, binary-size and independent security review. The decision, licenses, protocol gaps and review plan are in `../architecture/evidence/crypto-selection.md` relative to the core repository root. Later implementation must satisfy its application authorization and transactional freshness obligations; probe memory storage is not a protected store.

SEC-1.8 adds prepared protected immutable history, host attachment cache, exact
ciphertext backups and explicit labeled recovery exports in `src/assets.rs`.
Run `cargo test -p editac-security --test assets --locked`. The canonical harness
uses actual Session/HistoryStore/projection and source-preserving image adapters,
SQLite transactions, old-key failures, tampering, pending recovery and scoped
host export authorization. All metadata/content is sealed before persistent
writes; missing old keys yield unavailable history and export never runs as an
error fallback. Ciphertext restore is create-only and preserves edit policy.
See sibling `architecture/evidence/protected-assets.md` for bounds, disclosure,
cleanup and platform/review limits. Default production builds still expose none
of these qualification adapters; no production encryption claim is made.

SEC-1.9 adds `src/capabilities.rs`, the prepared local plaintext endpoint router.
Run `cargo test -p editac-security --test capabilities --locked`. Opaque relay
MCP/search/preview/decrypt/diff/edit/export requests fail closed. An explicitly
selected existing MLS/Session endpoint checks exact encrypted scope and current
host action authority, shares ordinary EditService readonly/edit admission, and
retains the SEC-1.8 fresh destination authorization for plaintext exports.
Discovery returns only advisory booleans; it does not acquire/unlock/delegate
keys. See sibling `architecture/evidence/plaintext-capabilities.md` for routing,
actual native integration cases and host cleanup/production wiring limits.

SEC-1.10 adds `tests/profile_conformance.rs` and the complete prepared suite:
`cargo test -p editac-security --locked`. Combined scenarios cover negotiation
failure followed by authorized protected delivery, opaque tamper receipts versus
semantic acknowledgement, and protected recovery with a retired MLS sender.
Sibling `architecture/evidence/encryption.md` maps all original attack fixtures,
exact dependency/source evidence and unresolved roadmap24 review/platform work.
This local review package does not enable a production encryption API or qualify
any platform by inheritance. Public fixture keys must never protect real content.
