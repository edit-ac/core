# Local comparisons with other editors

[Initial local results, 2026-10-13](../baselines/local-20261013.md) include Task
and Long diagnostics, exact raw samples and preserved failures. The edit.ac Long
fixture exceeded the 60-second preparation timeout; its measured timings remain
absent. The committed Task build also exceeds both gzip release caps.

[Dedicated text-route results](../baselines/local-text-route-20261013.md) correct
the insert/delete path to use the same `kind: 'text'` command family as normal
typing. The initial results used the general `kind: 'editor'` batch path, which
stages more work and can arrange the entire DOM. Reproduce that historical path
with `--command-route editor`; the default is now `--command-route text`.
Both experiments use the same frozen SDK revision. They are command-to-layout
measurements and include adapter target lookup; native keyboard latency and the
latest optimized SDK's timings still need separate measurement.

Run from `core`, with Node **24.19.0**, npm 11.17.0, Rust 1.97.1,
`wasm32-unknown-unknown`, wasm-bindgen 0.2.129 and the repository's locked
Playwright Chromium installed. Ensure the Rust tools are on `PATH`.

```sh
nvm use
npm --prefix benchmarks/comparison ci --ignore-scripts
npm --prefix benchmarks/comparison test
npm --prefix benchmarks/comparison run bench -- --quick --fixtures task
npm --prefix benchmarks/comparison run bench -- --quick --fixtures task,long
# More samples, two discarded warmups and five measured runs:
npm --prefix benchmarks/comparison run bench
# Freeze a particular committed version:
npm --prefix benchmarks/comparison run bench -- --revision <commit> --quick --fixtures task
# Select one group without mixing its capability claims:
npm --prefix benchmarks/comparison run bench -- --quick --profiles editac-task,tiptap-yjs,lexical-yjs
```

There is no CI job or change to the CI regression runner. Dependencies have a
separate exact-version package manifest and lockfile; installation does not
change the workspace dependency lock. Normal runs archive committed source,
verify every archived file against Git, install its locked dependencies and
build production WASM/JS in `benchmark-results/comparison-<timestamp>/source`.
They never build over an active checkout. Uncommitted SDK optimizations are
excluded. `--output` selects a result directory; an existing sample journal
cannot be overwritten. `--runs`, `--warmups`, `--samples` and `--timeout` permit
explicit diagnostic settings, all recorded in the report. `--source <snapshot>`
accepts only a complete Git archive with `.comparison-revision`; `--skip-build`
requires that explicit snapshot and records the reuse of its prebuilt artifacts.
Prefer normal fresh builds for comparisons.

The [manifest](../manifest.json) declares the shared mixed schema, corpus,
capability differences, source references, warmups/order and missing scenarios.
Task contains 20 blocks/10,240 UTF-8 bytes; Long contains 2,000 blocks/1,048,576
UTF-8 bytes. Reports separately record UTF-16 units and fixture hashes. Corpus v2
corrects v1's use of UTF-16 units for byte budgets; the v1 Long corpus exceeded
edit.ac's one-MiB bulk-creation byte cap. Failed v1 evidence is preserved and its
timings must not be combined with v2. Long remains a
diagnostic measurement rather than a support claim. The full architecture corpus
also needs Large, Aged, adversarial and multi-editor measurements, which remain
explicitly unmeasured here.

All profiles use vanilla DOM without React, virtualization or syntax highlighting,
the same stylesheet/viewport and loopback HTTP without throttling. Tiptap uses
StarterKit and the official Collaboration extension with its duplicate history
disabled. Lexical uses rich-text, code/list/link nodes, the official V1 Yjs
binding and its UndoManager. Yjs profiles include `y-indexeddb`, check a local
state-vector roundtrip and restore a newly saved edit after destroying the editor.
edit.ac keeps its real checkpoint/journal persistence and default Task preset.
These local Yjs bindings do not reproduce edit.ac's complete collaboration
protocol, crash recovery, writer lease or outbox guarantees. Edit-only profiles
and the DOM reference cannot establish a feature-equivalent size or timing win.
Full REL-1.2 qualification and its upstream gates remain open.

Measurements use the public command API through committed DOM and forced layout;
selection setup, full-text verification and fixture generation are outside the
operation timer. Cold activation reloads the page with HTTP cache disabled and
restores prepared local data for durable profiles. It includes adapter imports
and WASM initialization, but not document download, fixture preparation or a
fresh browser-process launch. Warm activation reuses initialized modules/WASM.
These endpoints do not measure native keyboard events or compositor paint.
Every edit checks both editor state and rendered text. Durability checks retain
a new sentinel edit across destroy/reopen; reseeding cannot pass that assertion.

Every run retains raw samples, discarded warmups, exact fixtures, source hashes,
profile/lock hashes, machine/browser versions, load averages, process inventories,
built adapters, required JS/WASM/CSS assets, esbuild metafiles and build logs.
Adapter gzip/Brotli totals include their integration code and all split resources;
the measurement harness and document payload are excluded. Required lazy WASM
and glue are included. The existing executable SDK size gate runs separately and
its hard-cap failures remain visible. Its exit does not prevent collecting
diagnostic timing evidence. Small samples omit p95/p99 and cannot establish a
tail-latency pass. Keep other workloads idle for a more controlled baseline.

Paste, reconnect, remote bursts, memory, mobile/IME and first-paint/input-to-visible
latency remain **Not yet measured**. Only deterministic local data/transports are
used. No AI providers, credentials, paid inference or external service setup is
part of this harness. Browsers, contexts and HTTP listeners close in teardown;
output evidence is retained deliberately.

Primary configuration references:
[Tiptap performance](https://tiptap.dev/docs/guides/performance),
[Tiptap collaboration](https://tiptap.dev/docs/editor/extensions/functionality/collaboration),
[Lexical editor state](https://lexical.dev/docs/concepts/editor-state),
[Lexical Yjs integration](https://github.com/facebook/lexical/tree/main/packages/lexical-yjs),
[Yjs IndexedDB](https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb).
