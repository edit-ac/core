# Packed first-command diagnostics

`scripts/bench-loading.mjs` measures the production packed SDK by default. Set
`EDITAC_LOADING_COMMAND_TRACE=1` for a separately labeled observer bundle. Both
runs use the existing loading profile, fixed Task/Long checkpoints, twelve
cold/warm pairs per fixture/preset, and the public edit/restoration oracle.
Retain unique output directories for each run.

The observer bundle uses the same externally installed package source closure.
It additionally exports existing engine, storage and renderer classes and wraps
their synchronous boundaries. Only that bundle receives the renderer callback
probe. The production bundle and its gzip accounting remain separate; observer
timings cannot replace production loading evidence or qualify startup targets.

Each accepted edit and restoration records exactly one storage command, prepare,
prepared commit, WASM commit, patch extraction and renderer callback. Admission
rejects missing, duplicated, reordered, overlapping sibling, out-of-window or unbounded
observations and unexpected payload fields. Exclusive intervals partition the
whole command window without subtracting harness or observer cost from budgets.

FFI intervals include generated marshalling and the Rust bridge. Storage residual
includes SDK JSON and synchronous observers; it is not an engine-internal phase.
Compare retained raw samples and exact source/package/runtime identities before
attributing a change. Twelve samples do not establish release tails; double RAF
does not establish compositor presentation. Full native, resource, accessibility
and canonical fitness admission remain separate unfinished requirements.

Run `node --test tests/loading-command-attribution.test.mjs` for deterministic
integrity negatives and `node --test tests/loading-command-evidence.test.mjs` for
the current pinned observer record. The canonical focused loading test accepts
only the production record in `benchmarks/profiles/loading-evidence.json`.
