# Optional highlighting companion

`editac-highlighting` derives syntax scopes from immutable code text. Construct
`Backend` explicitly and call `highlight(language, source, enabled)`. Results retain
the exact source and language, report fallback status, and carry ordered UTF-16
scope runs. No document, CRDT, engine, theme, HTML or network dependency is involved.
Only `rust`, `typescript` and `json` are admitted; other labels remain literal.

The pinned backend is Syntect 5.3.0 with its pure Rust fancy-regex implementation
and two-face 0.5.2+bat-0.26.1's newline-aware grammar bundle. See
[`backend.json`](../../fixtures/highlighting/backend.json) from the repository root
(`fixtures/highlighting/backend.json`) for asset hashes and grammar identities, and
`licenses/highlighting/` for backend and bundled syntax notices. The full grammar
asset is retained for cross-grammar dependencies, although only three languages
are exposed. This is an optional cost, absent from minimum engine/SDK dependency
graphs. The first implementation favors a reproducible portable bundle; it is not
an assertion that this footprint meets the default Task budget.

Inputs above 100 KiB, lines above 16 KiB, more than 4096 lines or more than 16384
scope runs return plain source with no partial tokens. Backend errors do the same.
These admission caps bound resources, not execution time. Cold grammar/regex work
can exceed an input frame; browser callers must use the later optional scheduler.
Incremental caching, cancellation and revision admission are owned by RCH-1.3;
worker lifecycle and editable DOM appearance by RCH-1.4/1.5. This crate currently
provides full recomputation only. Scope names are derived appearance, never marks.

From `core`, select the checked-in Rust/Node tools, set
`EDITAC_HIGHLIGHT_EVIDENCE` to a **new absolute** worktree-owned output directory,
and run `bash scripts/probe-highlighting.sh`. The script captures the named native
suite, WASM target check, optimized WASM build, wasm-bindgen Node runtime corpus,
raw warm samples, output parity and grammar/license inventory. `probe-wasm` is
qualification-only glue, disabled by default; it does not ship a browser worker.
Native functional samples use the debug profile; use the same suite with
`--release` for optimized native measurements. Record that distinction.

Qualification evidence and limitations are in the sibling architecture repository,
`decisions/highlighting-backend.md` and `evidence/highlighting-backend/receipt.json`.
No native UI, browser input, phone performance or additional language is qualified.

## Revisioned block cache

`cache::HighlightCache` owns one editing session. Pass an immutable `BlockInput`
to `begin` (or `begin_with_prior` with a previously returned opaque cache handle),
compute the move-only job with an optional worker's `Backend`, then call `publish`.
The returned `Published` includes the exact input, projection and optional cache
handle. Publication consumes its completion; superseding requests, cancellation,
disposal and replacement sessions reject late work. Delete a block with
`remove_block`; call `dispose` or drop the cache at session teardown.

Incrementality is **per block**: a changed block reparses completely, preserving
multiline parser state within that block; unrelated blocks reuse exact results.
The key includes block identity, revision, exact source, language, enabled state,
and grammar/query/theme identities. Reusing a revision for different bytes is a
miss. Only the pinned `BACKEND_ID` is supported as a grammar identity; another
version produces an explicit plain-source fallback. Syntect has no query asset;
query/theme strings identify the host projection profile and invalidate reuse.
A theme/query change does not claim a different parser implementation.

Default hard limits are 64 entries, 2 MiB retained payload capacity, 32,768 token
spans, and 16 pending blocks; callers may lower these limits. At most one cached
revision per block is retained and pressure evicts least-recently-used entries.
A result larger than the cache budget still returns validated tokens without a
cache handle. `retained_bytes` accounts for owned string/vector capacities and
entry records; fixed-cap container/allocator overhead is separate, not an RSS
measurement. Counters distinguish hits, misses, completed-backend-call blocks,
supplied bytes, evictions and rejected owned completions.

The host owns outstanding jobs/completions and must bound its worker queue and
release superseded snapshots. The port bounds its own pending records; it does
not keep abandoned jobs alive. `cancel_block` cancels queued/running work.
Cancellation is cooperative between bounded parser lines/regions, not inside a
regex operation. Worker timeout/termination and browser scheduling belong to the
browser scheduler gate. UTF-8/UTF-16 conversion and `validate_projection` reject
split scalars, overlapping/gapped/out-of-range runs and partial fallback tokens.
No cache operation accepts a writable document, CRDT or history handle.

Focused checks:

```sh
cargo test -p editac-highlighting --test highlight_incremental --locked
bash tests/highlight-engine-effects/check.sh
```

The isolated engine consumer uses its own lockfile and real engine checkpoint,
edit, undo and redo APIs. It adds no dependency to minimum SDK consumers.

## Optional browser worker

RCH-1.4 exposes the same cache through the opt-in `browser-wasm` binding
(`BrowserHighlighter`), independent of the engine WASM ABI. Run `npm run build`
and `npm run build:highlight-worker` from core with the pinned Rust/Node tools.
The latter emits web-target bindings and WASM under
`packages/web/dist/modules/code/backend/`; host these optional assets together.
Serve the public `@edit-ac/web/highlight-worker` module entry with its relative
JavaScript dependencies. Use `HighlightScheduler` and `createHighlightWorker`
from `@edit-ac/web/modules`, passing explicit host-owned worker/backend URLs.
Imports and disabled requests initialize no worker or grammar.

Each scheduler owns one worker and at most sixteen pending immutable block
inputs, coalesced by block. It admits the exact block/revision/source/language/
grammar/query/theme/enabled identity; token offsets and scope memory are checked
again before application. Timeout kills a stuck worker and returns unchanged
source with no tokens. Superseded/disposed promises settle without application.
Dispose the scheduler when its session ends; replacement workers start with a new
cache. Startup includes worker boot and lazy grammar initialization; transfer,
backend work and the optional host apply callback are timed independently. The
apply callback must not mutate editor semantics and should return promptly.
The scheduler does not implement the RCH-1.5 composing-subtree presenter policy.
`node --test tests/highlight-scheduler.test.mjs` requires the built optional assets
and includes actual Chromium module-worker/WASM execution, with no provider calls.
