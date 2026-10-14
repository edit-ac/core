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

The semantic group intentionally fails while original required cases are unqualified. SEQ-03/07/13/14 currently stop at missing history selection bookmarks; supported preceding checkpoints remain visible. Required REG-05 alignment/atom and REG-07 cross-owner code/text paste and history selection variants remain unqualified. The regression variant suite adds preceding-trigger deletion, empty-destination pending-mark lifecycle and selected paste with content undo within text/code blocks, plus retained failing cross-owner regressions; it does not close the parent gate. Content undo of separated pre fragments is partial evidence only. The group writes bounded case/checkpoint facts and source/fixture/profile hashes to `harness.json`, with teardown facts for its private asset server and extracted package. It does not overwrite the RGS-1.1 receipt or claim a parent gate pass from a filtered run.

RGS-1.2 regression variants run as a separate named suite, without skipping known full-group failures:

```sh
EDITAC_EDITING_PACK_TARBALL=/absolute/path/to/qualified-core.tgz \
EDITAC_EDITING_OUTPUT=/absolute/path/to/fresh-evidence \
npm run test:editing -- --group semantic --cases regression-variants
```

Unknown case selectors fail. This suite asserts actual public prepared-operation boundaries, publication counts, stable identity, result caret and explicit pending marks with independent snapshots and negative controls. Native counterparts in `editing_regressions.rs` prove the document boundary; pending state stays editor-local. Prepared pre fragments are semantic inputs, not proof of an HTML parser or OS clipboard. Content undo/redo never claims restoration of direction/affinity through the absent history bookmark port.

The full semantic group includes these variants. The named variant suite currently fails its forward/backward cross-owner code/text paste cases; both native Rust and packed WASM reject them before commit. No selector omits those cases, and rejection is not reclassified as the requested paste/undo behavior.

G03 returned selection across a real unrelated replica edit has a dedicated suite:

```sh
EDITAC_EDITING_PACK_TARBALL=/absolute/path/to/qualified-core.tgz \
EDITAC_EDITING_OUTPUT=/absolute/path/to/fresh-evidence \
npm run test:editing -- --group semantic --cases selection-results
cargo test -p editac-core --test editing_regressions g03_remote_ --locked --offline
```

`selection-results.test.mjs` composes public prepare/commit, retained result tokens,
checkpoint restore, real replica delta, resolution and publication ports. Eight
independent `selection-vectors.json` cases cover replacement/formatting, forward
and backward endpoint order, and left/right affinity. A next sentinel replaces
the resolved range; both document/source identities and unrelated remote content
must survive. Negative controls corrupt each endpoint, direction, affinity,
owner, remote content and publication count. The full semantic dispatcher includes
this suite. These supplemental vectors do not replace architecture recipes or
qualify split/paste selection, history bookmarks, browser gestures or devices.
Duplicate-update idempotence belongs to the properties owner (G10), separately
from the single unrelated update in this G03 proof.

REG-06 schema-crossing rejection has a matching native/packed suite:

```sh
EDITAC_EDITING_PACK_TARBALL=/absolute/path/to/qualified-core.tgz \
EDITAC_EDITING_OUTPUT=/absolute/path/to/fresh-evidence \
npm run test:editing -- --group semantic --cases schema-rejection
cargo test -p editac-core --test editing_regressions reg06_matrix_ --locked --offline
```

Use the pinned Node 24.19.0 runtime. Twelve authored vectors cover deletion,
replacement and formatting across code/marked-paragraph owners, forward/backward
selection and left/right input bias. Real prepare rejection retains the full bold
suffix, schema, owner/source/span identity and both input anchors. Checkpoint,
state vector, revision, history and publication remain unchanged. Each case has
16 corrupted-oracle controls. These vectors prove atomic rejection only; they do
not qualify an accepted cross-owner policy, history bookmarks or unattached
journal/persistence effects. Canonical semantic dispatch includes this suite.
