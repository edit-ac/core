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

Ordered mixed-batch rejection/retry proof (RGS-1.2-C8):

```sh
EDITAC_EDITING_PACK_TARBALL=/absolute/path/to/qualified-core.tgz \
EDITAC_EDITING_OUTPUT=/absolute/path/to/evidence \
npm run test:editing -- --group semantic --cases mixed-batch
cargo test -p editac-core --test editing_regressions reg13_mixed_ --locked --offline
node --test tests/editing/dispatcher.test.mjs
```

The supplemental hand-authored vectors consume SEQ-11 through the shared driver.
Twelve packed cells cover forward/backward result direction, left/right bias and
editor-local null/empty/nonempty pending marks; four native vectors prove the
matching document/selection contract. Each rejects a missing final mark owner, a
staged surrogate-interior mark range and a staged surrogate-interior selection,
then retries once. Exact content, inserted-only bold, suffix/source/identity,
returned endpoints, history, revision/vector and publications have falsifying
controls. Pending marks are editor-local; unattached journal/persistence and
remaining REG-13 structure variants are unproved. The canonical semantic group
includes this suite; its selected pass does not qualify the full parent.

G06 Unicode owning assertions use the existing independent `semantic-vectors.json`
NFC/NFD/ZWJ/flag/Indic/bidi/authored-space/interior/boundary vectors:

```sh
EDITAC_EDITING_PACK_TARBALL=/absolute/path/to/qualified-core.tgz \
EDITAC_EDITING_OUTPUT=/absolute/path/to/fresh-evidence \
npm run test:editing -- --group semantic --cases unicode
cargo test -p editac-core --test editing_regressions g06_ --locked --offline -- --skip reg06_ --show-output
```

The selected suite is mandatory in full semantic dispatch. Both biases preserve
independently authored content, empty marks, owner/source identity and exact
prepared endpoints; every vector has corruption controls. Rejected/no-op vectors
retain revisions, state vectors, checkpoints, history and publications. Packed
boundary and combining-interior dispositions occur in the shared adapter without
engine commits; native boundary uses `deletion_range` returning no range and dispatches no
engine mutation. An explicit empty replacement is a different operation. Native pending state, visual movement,
actual deletion gestures and whole-version Unicode conformance remain unproved.


## Pending lifecycle owning proof (RGS-1.2-C10)

`npm run test:editing -- --group semantic --cases pending` executes both existing
G04 sequence families through the packed engine and SemanticDriver. The shared
`pending-vectors.json` authors every intermediate state, explicit null/empty/bold
pending set, both logical endpoints and bias, and the native committed operations.
The empty split destination is revisited before restoring the override; final
sentinels prove derived context. Real subscriptions and commit wrappers observe
publication/result counts. Pending, selection and rejected actions freeze engine
content, revision, checkpoint, vector and history. The default history policy
isolates each commit; the driver clock remains fixed at zero.

`cargo test -p editac-core --test editing_regressions g04_pending_ --locked --offline -- --show-output`
mirrors six committed text/split operations. Native does not invent editor-local
pending state or claim native execution for adapter-only actions. Split returns a
caret, while ordered replace/mark returns a range. Original source spans survive;
new structural identities bind at their creating split and must remain stable.
Every sequence contains falsifying controls. Canonical semantic dispatch includes
this suite; selected passes do not close original REG-05 alignment/atom variants,
history bookmarks, journal/persistence, or the full parent gate.
