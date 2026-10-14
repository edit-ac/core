# Exact upgrade and rollback boundary

FIT-1.5 qualifies only the previous reviewed core revision
`8f1eec24a4c3863a31cc00e6d91384b23f2c2355` and current pre-batch revision
`f25b08ab6cca6b967f9c0109030952f71a3778a4`. Both have schema-v5,
wire/profile-v5 with protocol/update encoding 1 and UTF-16 offsets,
descriptor version 1, public API contract 1 and native preparation ABI 1.
Package version `0.0.0` alone is not a compatibility identity.

`fixtures/compatibility/policy.json` pins the complete portable executable
source closure at both revisions. The suite checks every pin against Git and
the working tree. Cargo dependencies and resolved npm packages are identical;
the npm lock root dev-tool declaration changed to include Babel, and both
distinct lock hashes are retained. Equality of the executable closure lets the
same freshly compiled runtime qualify these exact source identities. It does
not establish support for arbitrary historical artifacts or prebuilt packages.

Immutable v4/v5 checkpoints contain actual structural split operations,
UTF-16 text, unknown extension attributes and future descriptor data. Separate
binary journal updates exercise persisted recovery. The current public Rust
Document reader and the qualified Yjs mappers can read each matching profile.
The JS SDK and native FFI admit v5 only. Cross-profile restore rejects;
relabeling a v5 checkpoint as v4 also rejects, so a package rollback cannot
silently reverse persisted schema changes. No schema migration is qualified.

The canonical harness compiles actual Rust/UniFFI and browser WASM code, builds
the exported JS API, exchanges owned checkpoints in both native-to-JS and
JS-to-native/Rust directions and checks preserved projections/unknown data.
It calls actual wire admission and descriptor registration/resolution.
Unknown implementation revisions and unsupported public API/ABI tuples are rejected by the build-time policy before
dispatch; the native engine's actual ABI version and generated record lower/lift
tests anchor ABI 1. This is portable ABI preparation, not target-platform SDK
qualification. Prepared descriptor migration returns candidate data requiring
host admission; an undeclared reverse transition never calls the migrator.

Unsupported tuples preserve the original checkpoint/journal. Recovery requires
a matching reader, or explicit export before a separately admitted new epoch.
The suite verifies the original remains readable and unchanged after rejection.
It neither rewrites persistent storage nor claims a lossless export to a legacy
schema. Unknown descriptors remain opaque data and confer no authority.

Run `node scripts/check-architecture.mjs --suite compatibility` on pinned Node
24.19.0/Rust 1.97.1 with `EDITAC_ARCHITECTURE_OUTPUT` set to a fresh durable
directory. Validation never regenerates corpus files. Explicit deterministic
fixture preparation is `node scripts/prepare-compatibility-fixtures.mjs --prepare`;
preparation refuses to replace existing frozen bytes. Changed fixtures require a new reviewed corpus identity, policy hashes and verification.
Receipts include nonzero Node and nested Rust counts, build logs, exact source,
fixture and compiled artifact hashes. No network/provider calls or publication
are part of this boundary.
