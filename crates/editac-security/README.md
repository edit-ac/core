# Optional security qualification

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
