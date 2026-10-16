# Development regression and performance checks

Run from the `core` repository. Runners reject a different Node version before building or executing tests. Full runs can take tens of minutes while the editor exceeds the proposed latency targets; use small/medium quick runs for frequent feedback. These checks execute the real Rust/WASM engine,
browser SDK, IndexedDB recovery, input handling and DOM renderer with deterministic
documents. The fixtures contain 5, 50, 100 and 250 logical blocks respectively; the structured fixture nests list items. They never use an AI provider, secrets file or paid inference.

## Setup

Use the versions in `.node-version`, `package.json`, `rust-toolchain.toml` and
`package-lock.json`. Node 24 is the CI toolchain. The locked Playwright package
selects the Chromium revision; do not use an arbitrary system Chrome.

```sh
nvm use # or select .node-version with your version manager
npm ci --ignore-scripts
cargo fetch --locked
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npx --no-install playwright install chromium firefox webkit
```

On Linux, add `--with-deps` to the Playwright install command. Rust must have the
`wasm32-unknown-unknown` target installed. Both main commands rebuild release WASM
and package output first, so source changes are measured rather than stale builds.

## Local commands

```sh
npm run test:bench                          # fast benchmark contract tests
npm run test:regression                     # all Node and browser regression files
npm run test:regression -- --browser firefox
npm run bench:quick                        # every fixture, reduced diagnostic samples
npm run bench -- --quick --fixtures small,medium
npm run bench                              # 2 discarded warmups + 5 measured runs
npm run bench -- --enforce                  # enforce every proposed budget
npm run bench:watch                        # watch small/medium fixtures
```

The functional runner first executes the native patch/math/module-registry fixture generators and retains their bytes and Rust test counts. It then discovers all `tests/*.test.mjs` and
`tests/browser/*.{spec.ts,test.mjs}` files. It runs serially to avoid competing browser work
and rejects failures, skipped/cancelled tests and zero executed tests. Browser
selection applies to harnesses that support it; specialized suites retain their
explicit engine matrix. Detailed logs, per-browser receipts and a total-count
receipt remain in `regression-results/<timestamp>/`. The existing
`npm run check:rust` remains the Rust unit/integration gate.

The watcher defaults to small/medium quick measurements; pass --fixtures small,medium,large,large-structured to include the stress cases. The watcher coalesces changes and queues one follow-up if a run is in progress;
it does not run overlapping measurements. It watches `packages`, `crates`,
`benchmarks` and `scripts`, ignoring generated output. Stop with Ctrl-C. Changes
to root manifests or toolchains require restarting the watcher. Keep other
browser tests/builds idle when recording a comparison baseline.

## Comparing changes

```sh
npm run bench -- --save-baseline benchmarks/baseline.local.json
# After adding/changing a feature:
npm run bench -- --baseline benchmarks/baseline.local.json
```

Choose a baseline filename that identifies the machine. Baseline creation is an
explicit command; quick or partial runs cannot overwrite an accepted full-run
baseline. Review the generated report before committing a baseline or a changed
budget. A measured warning result can be saved, but it does not qualify the MVP.
There are no invented historical results checked into this repository.

Timing deltas require the same fixture version/hashes, selected fixtures, run/sample
counts, delay, metric endpoint, Node major, browser version, OS/architecture and
hardware class. The report omits incompatible timing deltas. Bundle deltas require
the same bundle measurement version. A missing previous baseline is reported
explicitly. Run full checks on the same quiet machine for meaningful comparisons;
local numbers do not establish a Linux CI or physical-device performance claim.

Each run saves `results.json`, `raw.json`, `summary.md`, build logs, exact generated fixture JSON, production JS/WASM/glue
bundles and esbuild metafiles in `benchmark-results/<timestamp>/`. Warmups remain
in the raw evidence with `measured: false`. Source revision/dirty state, fixture
hashes, built artifact hashes, hardware, load average, sample counts and browser
version are recorded. Use `--output <new-directory>` to choose the destination.
These generated directories are ignored by Git. Preserve failed evidence.

## Measurements and gates

| Scenario | Measurement / assertion |
| --- | --- |
| Typing and backspace | Start/middle/end of each 5k, 50k, 500k and structured 500k fixture; exact resulting DOM text |
| Bold, italic, heading | Public format commands through the actual commit path; resulting mark/block projection |
| Undo/redo | Input history commands; exact restored and redone text |
| Cold load | Production JS/module import through initialized WASM in a fresh browser context |
| Cold/warm editable | `createEditor` through recovery, first accepted edit and DOM/layout; warm reuses the initialized runtime |
| Large paste | 100k-character Markdown source into a 500k document; exact parsed inserted text and undo |
| Select-all format/delete | All blocks of the 500k document converted to headings with exact style undo; 100k text-owner deletion/undo in a 600k document |
| Remote update | Real Yrs peer update delivered after a concurrent local edit; both edits retained and projected |
| Memory | Forced-GC snapshots outside latency samples, after 1,000 inserts and five mount/destroy cycles |
| Bundle | Minified/tree-shaken ESM, WASM and glue; individually compressed gzip/Brotli totals and component hashes |

If the React package exposes its host bindings, a third size profile includes the full SDK plus the thin React wrapper. React is an external peer; its framework runtime is excluded and identified in metadata. The wrapper profile uses the 400 KiB full-editor budget.

Each fixture/iteration gets a fresh browser context. Spellcheck is disabled,
service workers are blocked, and requests to origins other than the local fixture
server are rejected. Fixture creation/persistence happens in a setup realm that is reloaded before measured cold startup;
the editor loads an existing checkpoint, as the SDK contract requires. A small
test-only host recovery helper captures the normal recovery session for peer
updates and history setup; it does not replace the engine, storage or renderer.
Production bundle budgets use public package exports without that helper.

Latency starts immediately before command/input dispatch and stops after the
synchronous DOM update and forced layout. Constructed backspace events supply a target range for the known inserted ASCII character. It excludes Playwright transport,
selection setup, assertions and simulated inter-key delay. It does **not** measure
compositor paint, actual OS keyboard/IME latency, network bandwidth or first-ever
browser-process startup. Cold editable includes the module/WASM load through the first accepted edit. Cold module/WASM loading uses the fixture server's
`no-store` policy. Warm editable uses the already initialized runtime, not a
separate HTTP-cache or browser-process-cache experiment.

Each measured run produces nearest-rank p50/p95 values. The headline values are
the median of the five run percentiles; raw maxima are also retained. There are
50 edit samples per run/position, ten format/history samples per run, five expensive-operation samples per run and
one startup sample per run. The memory stress/cycle phase runs once, in the last measured large-document context, rather than repeating 1,000 edits in every latency iteration. No p99 is claimed from these sample counts. Quick
runs use one warmup/run, five edit samples, two format/history samples, two expensive operations, 100 memory
edits and two mount cycles; they are diagnostic only.

`config.json` preserves the proposed v0.1 budgets: typing p95 8 ms for small/medium
and 16 ms for large, cold JS/WASM 300 ms, warm medium editable 50 ms, cold large
editable 500 ms, paste 200 ms, full bundle 400 KiB Brotli and minimal bundle
150 KiB Brotli. Growth above 5% in bundle size or 20% in latency is reported.
The 20% latency rule is an initial regression heuristic, not a statistical
significance claim. Large typing above 25 ms always fails. Other performance
findings warn during stabilization; `--enforce` makes them fail. Functional errors,
missing/invalid samples and teardown errors always fail. Checkpoint preparation is capped at five minutes and each browser scenario at ten minutes; host-side timers can stop even a blocked WASM call. Completed phase samples survive an interrupted or failed scenario and are labeled incomplete or warmup-only. A failed retry never
deletes the first attempt's evidence.

CDP heap snapshots record JS heap and external backing storage separately;
backing storage is not exclusively WASM. WASM may keep a high-water allocation.
Memory has no accepted absolute/growth threshold yet. The structured fixture
contains headings, code and nested lists. Tables, virtualization/frame-drop
profiling, React browser timing, and pinned
Tiptap/Lexical comparisons are explicitly **not yet measured** in this initial
implementation. Adding those scenarios requires a fixture/measurement version
change and actual results, rather than placeholder baseline values.

## CI

`Editor regressions and benchmarks` runs on relevant pull requests and main
pushes, nightly at 02:15 UTC, and on manual dispatch. The `benchmarks` job follows `regressions` and retains performance evidence even if functional tests fail; that build remains unqualified. The benchmark job uses the same full local command,
restores the last complete main measurement when its artifact exists, publishes a
GitHub job summary and uploads all raw results/bundle analyses. Performance
failure retries once in a separate output directory. Correctness failures remain
visible in the preserved first attempt. No PR-comment write permission is needed.

Keep `ENFORCE_BUDGETS` false while collecting Linux runner baselines. Turn it on
in a reviewed change once the budgets and variance are accepted; manual dispatch
also has an `enforce` input. A warning or diagnostic run is not performance
qualification, and a job that has never run in GitHub is not a green CI claim.

The runners close their task-owned browser controller, HTTP listener, IndexedDB
connections and temporary fixture directory in teardown, including failures and
interruptions. Reports/logs are retained intentionally. After larger sessions,
inspect disk free space and remove only inactive outputs you no longer need.

Implementation references: [Playwright library](https://playwright.dev/docs/library),
[Chrome heap usage](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage),
[esbuild](https://esbuild.github.io/api/).

## Architecture fitness baseline traces

`npm run bench -- --fitness --quick --fixtures small,medium --output <unique-directory>`
adds the FIT-1.8 raw baseline observations documented in
[the budgets suite](../tests/architecture/budgets/README.md). This opt-in mode changes
the sample endpoint and comparison signature. Synthetic input, forced layout and
two animation frames are diagnostic observations; they do not establish paint,
OS input, full PRF coverage or a qualified resource envelope. Existing budgets
and the ordinary runner endpoint are preserved.

### Packed offscreen-layout experiment

`EDITAC_LOADING_LAYOUT_PROBE=control`, `auto` or `auto-dirty`, with the existing
`scripts/bench-loading.mjs` command, compares the unchanged packed renderer with
an inline CSS derivative (`content-visibility:auto` on direct block/container
children; an initial 24px intrinsic block-size estimate). This is an experiment,
not shipped SDK CSS. All modes enable Chromium accessibility before navigation.
Use the same pinned checkpoints, features, host/browser and complete 12-pair
Task/Long matrix for each mode; preserve the existing limits and raw samples.
Do not run the two measurement processes concurrently.

`auto-dirty` additionally observes source mutations from navigation onward in
every timed pair. After initial synchronous projection, it permanently removes
content visibility containment from changed top-level owners, including lists
containing changed text and inserted/replaced owners. This tests a repair for
Chromium's stale AX text after editing a contained owner. Its observer disconnects
on page hide. It is a fixture-lifetime candidate, not a production editor-lifetime
implementation; all its runtime work stays inside measured navigation timing.
`EDITAC_LOADING_AX_STAGES=1` also checks complete owner coverage before/after the
first edit/restore and before/after offscreen edit/restore. Missing stages or
owners fail the final AX case. Staged timings include those extra protocol
queries and must remain separate from ordinary candidate startup timings.
The retained `startup-dirty-1` experiment repairs final edited-owner coverage but
still fails initial Long owner coverage. Whole-document selection can materialize
previously absent AX text, so a later full-text pass cannot qualify earlier stages.

After accepted-edit timing, the first cold/warm pair in each family executes
UTF-16 selection/keyboard, scroll/range, code/list geometry, complete selection
and actual clipboard copy, bounded offscreen copy, browser find, offscreen public
edit/restoration, and editor-subtree AX text/focus-action probes. Counts and every
failed observation remain in `behavior/` and `results.json`; behavior failures
make the owning command exit nonzero even when the 24 loading observations pass.
These probes do not qualify nested lists beyond the fixed corpus's one level,
OS screen readers, compositor presentation, or tail latency. They occur after
the accepted-edit endpoint; the experimental `finalRead` phase also includes
probe overhead and must not be compared as ordinary read latency.

The full Long copy probe deliberately remains a failure when its 1MiB text plus
block separators exceeds the existing clipboard port's 1MiB limit. Never raise
that limit, shorten the corpus, count a bounded copy as full copy, or hide a
missing AX subtree to make this experiment pass. Enabling accessibility only
after startup is a distinct probe configuration, not comparable startup proof.
`inspectLoadings` rejects experimental metadata, behavior records and retained
experiment artifacts from canonical admission. A candidate needs the stated
behavior and original performance criteria before production adoption; a faster
failed experiment cannot qualify FIT-1.8.
