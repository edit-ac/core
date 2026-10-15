# Disposable editor stage cost probe

`node scripts/bench-editor-stage.mjs --pack <core.tgz> --seeds <retained owning directory> --output <unique directory>` measures the public packed Engine's `prepare` and `commit` calls for ordered `replaceAt`/`selectionAt`. Use the same harness, fixed Task/Long checkpoints, host and runtime for a before/candidate comparison. Run comparisons serially after other measured workloads finish. The output directory must be new.

Each of 12 samples per fixture restores a fresh engine, checks the entire corpus against the independent fixture generator, replaces one character, validates backward result offsets and biases, restores the original character, checks the entire corpus again, and reopens its resulting checkpoint. All engines, result anchors, the local WASM server and temporary package directory are disposed. The receipt retains the package, exact checkpoint/source hashes, raw preparation/commit costs, sample outcomes and cleanup. Source revisions and implementation differences belong in the enclosing delivery receipt; a tarball's hash does not establish source provenance by itself.

Times cover only public FFI preparation/commit, excluding assertions, restore, rendering and transport. No warmup is discarded. The feature set and exact corpus sizes are recorded. These 24 cases prove the bounded implemented command path and corpus recovery, not the full browser startup, trusted input, native SDK, accessibility, resource or release gates. Twelve samples cannot qualify p95/p99 tails. Existing navigation-to-accepted-edit limits must remain unchanged; do not compare a component time against that whole-path budget or claim a universal speedup.

Append `--anchored` to exercise the ordinary public anchored delete+insert
chain, preceded by its entry history selection and followed by the same backward
result selection. Anchor capture is outside measured prepare/commit spans and
all captured tokens are released on both success and failure. Compare identical
modes only; offset replacement is a separate diagnostic boundary.

Use `--chain` for the exact plain delete+insert command shape of PRF-06's
ordinary public chain, with no entry/result bookmark commands. It retains the
same full fixture and reopen assertions. Keep this mode separate from the
keyboard-style `--anchored` bookmark probe in all summaries.

The editor reuses its disposable stage across read-only selection bookmarks and
consecutive anchored text commands. A private next-text snapshot refresh applies
only when each touched source belongs to one complete visible owner; split,
joined and shared recovery ownership falls back to the observed stage index.
Structural commands invalidate that private snapshot. This view never becomes a
public projection: final complete ownership, immutable-source and size admission
still runs before a plan can commit. Delete-only transactions must refresh text
even when their Yrs state-vector clock does not advance. The transaction regression
compares exact encoded updates with independently restored per-step plans across
v4/v5, bookmark and joined-source variants, and checks silent late rejection and
undo. Each variant uses a distinct creation epoch to respect process-wide creation
authority.
