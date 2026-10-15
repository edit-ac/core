# Optional security dependency probes

This unpublishable crate is the SEC-1.2 compile-only candidate boundary. Default features are empty and the semantic engine does not depend on it. The private `protocol-probe` module type-checks OpenMLS group creation, application messages, processing, membership and epoch operations without executing them. No production encryption API is exposed.

Run from the core root with the pinned Node/Rust toolchains:

```sh
node --test scripts/check-security-targets.test.mjs scripts/check-security-dependencies.test.mjs
node scripts/check-security-targets.mjs --all
node scripts/check-security-dependencies.mjs --evidence .artifacts/security-dependencies
```

The target manifest is `scripts/security-targets.json`. Missing targets fail qualification. rlib compilation is separate from linking, runtime/RNG, storage, platform, binary-size and independent security review. The decision, licenses, protocol gaps and review plan are in `../architecture/evidence/crypto-selection.md` relative to the core repository root. Later implementation must satisfy its application authorization and transactional freshness obligations; probe memory storage is not a protected store.
