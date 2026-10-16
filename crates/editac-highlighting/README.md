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
