# Public extension conformance fixtures

`conformance.json` is the fixed EXT-1.3 cell manifest. It reuses the qualified
registration corpus and math descriptor; it adds built-in opaque block examples,
UTF-16 boundary cases, disabled registration/presentation, malformed envelopes
and bounded descriptor rejection. Each cell has a stable ID and explicit outcome.
Slash and reorder have no persisted descriptors; their ownership remains in
`entry-map.json`. The block examples prove preservation with absent presenters,
not renderer, codec migration or command/lifecycle parity.

The Rust helper in `crates/editac-core/tests/support/extension_conformance.rs`
and public `@edit-ac/web/modules` exports `runDescriptorFixture`,
`canonicalSemanticJson` and `projectExtensionNodes` let subsequent fixtures reuse
the existing registry and canonical semantic comparisons. A reported rejection
must match the fixture's expected outcome; it is not successful data admission.
Host callbacks are outside the fixtures and document state.

From `core`, select the checked-in Node/Rust toolchains and set
`EDITAC_EXTENSION_CONTRACT_OUTPUT` to a unique absolute directory owned by the
worktree. Then run:

```sh
npm run build --workspace @edit-ac/core --workspace @edit-ac/web
cargo test -p editac-core --test extension_contract --locked
node --test tests/extension-contract.test.mjs
```

Rust executes 44 manifest cells and writes results plus 13 real Document
checkpoints and semantic projections. Web executes each cell and restores every
checkpoint through production WASM, validates the public registry, compares
Rust/web semantics and restores another checkpoint to prove lossless recovery.
Results include explicit source fallback. Unknown types/versions may have shapes
that current modules cannot interpret; their original bounded JSON and text stay
inert and recoverable. Tests do not compare CRDT byte ordering.
