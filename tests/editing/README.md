# Shared editing regression contract

Run with Node 24.19.0:

```sh
node --test tests/editing/fixture-loader.test.mjs
node node_modules/typescript/bin/tsc -p tests/editing/tsconfig.json
npm run test:editing -- --group fixtures
```

`fixture-loader.ts` consumes the sibling architecture manifest, recipes and catalogs directly and reuses its planning validator. Catalog rows, source-authored variant clauses, declared platform/profile constraints and risk policies remain planned metadata. Capability bindings require both declared capabilities and implemented action handlers. Known groups without runtime suites fail explicitly; future owners add their named suites to the dispatcher.

`driver.ts` accepts an actual `EngineRuntime`; each driver creates an isolated v5 document identity and alias registry. New aliases bind to the engine-returned structural caret, never matching text. A single prepared fragment handles replacement. For text replacement without an explicit engine caret, the adapter resolves a retained right-biased upper endpoint, as the production text adapter does. Snapshots read the engine projection; expected snapshots stay architecture-authored. Publication counts come from real update subscriptions. The clock is explicit and monotonic; it does not fabricate history support.

The initial `rgs-paragraph-v1` profile supports unmarked paragraphs, text selections, split, hard break and typing. Code/marks, pending-mark overrides, history selection, input/DOM, asynchronous ownership and other capabilities require owning adapters. The fixture test uses the SDK-qualified default core tarball in `architecture/evidence/browser-size-optimization/compound-order-2/default/`, unpacks it without workspace aliases, loads its public runtime and closes its private WASM asset server and temporary package in teardown.

Evidence distinguishes corpus binding, representative recipes and partial replacement checkpoints. SEQ-13/14 first-checkpoint evidence does not qualify their undo/redo/sentinel steps. Six corrupted expectations demonstrate snapshot sensitivity; this is prerequisite evidence for G14, not full guard/coverage qualification. No native/device, provider-quality or exhaustive variant claim follows from these tests.

The RGS-1.2 semantic group uses `semantic-adapter.ts` and a caller-selected immutable packed core artifact:

```sh
EDITAC_EDITING_PACK_TARBALL=/absolute/path/to/qualified/edit-ac-core-0.0.0.tgz \
EDITAC_EDITING_OUTPUT=/absolute/path/to/fresh/evidence \
npm run test:editing -- --group semantic
cargo test -p editac-core --test editing_regressions --locked --offline
```

Use the pinned Node runtime above. The adapter forwards invalid batch owners/ranges to engine admission and uses ordered `replaceAt`/`markAt` plus final `selectionAt`; both returned tokens are resolved and released. It observes actual updates, history state, revision, checkpoint bytes and state vectors. Persistence is unattached and is never represented as an observed zero. Paragraph/code snapshots retain logical aliases and actual engine identity; fragment creation binds aliases to the created structural projection and terminal result caret, never text matching. Pending marks are transient driver state; null, explicit empty and nonempty overrides are distinct. Affinity determines the context side at a mark boundary.

`fixtures/editing-failures/semantic-vectors.json` contains independent fixed atomic/Unicode vectors shared with native Rust. Receipts record the actual Node ICU/Unicode versions and Cargo.lock hash; the Node and Rust segmentation versions differ, and these named vectors do not claim whole-version Unicode conformance or native deletion gestures.

The semantic group intentionally fails while original required cases are unqualified. SEQ-03/07/13/14 currently stop at missing history selection bookmarks; supported preceding checkpoints remain visible. Additional required REG-05 alignment/rule/atom and REG-07 mixed text/code paste/history selection variants remain explicit failures. Content undo of separated pre fragments is partial evidence only. The group writes bounded case/checkpoint facts and source/fixture/profile hashes to `harness.json`, with teardown facts for its private asset server and extracted package. It does not overwrite the RGS-1.1 receipt or claim a parent gate pass from a filtered run.
