# Native shared Session Rust proof

NSR-1.1 exposes the actual shared `Session<Arc<NativeStore>>` through the existing UniFFI library. The adapter delegates atomic preparation, permissions, revision admission, history, journaling and recovery to `EditService`/`Session`; a private Rust worker owns their complete lifetime. No Session internals or Swift adapter were added.

`receipt.json` pins exact source bytes, compiled test artifacts and retained logs. Final Rust coverage is 45 unique passes (15 new Session cases), zero failures/skips; the complementary compatibility phases collectively execute all 11 cases. The actual existing public JS runtime roundtrip passes once; architecture checks pass 14 cases. SQLite files remain at the worktree-local path and hashes in the receipt. Historical failures remain here, including the initial read/fault-fixture failure, optional-revision compile repair, and broad-Cargo compatibility setup failure.

Reproduce native Rust ownership cases with `EDITAC_NATIVE_SESSION_EVIDENCE` set to a fresh absolute evidence directory and `cargo +1.97.1 test -p editac-ffi --lib --test native_session --test native_abi --locked`. Compatibility needs the outbound Rust phase, actual public JS checkpoint, then return Rust phase; the retained driver records this setup. Its original worktree evidence paths must be changed to a fresh directory before reproduction.

Generated Swift runtime qualification and consumed-contract applicability remain NSR-1.2; monitor integration remains NSR-1.3. This proof does not close original DSK-1.3, an AppKit view callback case, native SDK/IME/release qualification, or current upstream/browser source admission. No paid inference, credentials, external messaging or publication.
