# Feature-aware architecture fitness

`node scripts/check-architecture.mjs --suite budgets` validates the reviewed
`benchmarks/profiles/fitness-v1.json` policy and content-addressed baseline index.
It rejects changed source/artifacts, missing raw samples, incomparable inputs,
unknown profiles, skipped/failed cases, post-hoc limits and prepared runtime
claims. The suite is an admission contract with actual baseline observations;
a passing test receipt does not qualify all PRF cases or a release profile.

The owning baseline command is the existing `npm run bench -- --fitness --quick
--fixtures Task,Long --presets baseline,task --output <unique-directory>`. It rebuilds the real
Rust/WASM engine and browser SDK and uses deterministic document checkpoints,
IndexedDB recovery and the real input/renderer lifecycle. `--fitness` adds raw
synthetic dispatch, forced-layout and two-animation-frame timings, DOM mutation
scope, long tasks and repeated mount/dispose heap/surface observations. Keep the
endpoint separate from compositor presentation and real OS/IME input. Forced GC
occurs outside latency windows. These quick samples are diagnostic; p95/p99 are
inconclusive. Task has20 blocks and10,240 UTF-8 text bytes; Long has2,000 mixed blocks and1,048,576 UTF-8 text bytes. Committed seeds and expected semantic snapshots are in `benchmarks/fixtures.mjs` and `benchmarks/expected/`. UTF-16 lengths, UTF-8 text bytes/hashes, semantic snapshots and serialized CRDT bytes/hashes are separate identities. The owning command compiles `crates/editac-ffi/examples/fitness-seed.rs` with a prepared frozen-schema-v5 initializer over public native-created text, validates it through public native restore and constructs the structured fixtures outside measurement windows. It retains the executable, logs, checkpoint and native snapshot, validates the committed semantic oracle, then restores those same bytes with the actual browser WASM engine. This is prepared fixture initialization, not native command/platform qualification. Interrupted runs can supply prepared native seeds with `--seed-directory <retained-output>`; admission checks the current Rust/Cargo source closure, freshly built executable hash, exact generator JSON, completed producer log and independent semantic oracle. The new run retains a reuse receipt and all copied producer artifacts. Browser restoration independently checks checkpoint semantics; no prior browser status is inherited. Native preparation has a ten-minute child-process limit and stops its exact owned process on timeout. One actual initial checkpoint per fixture is retained and reused byte-for-byte across every preset/warmup/measured run.

`baseline` mounts the minimal SDK with shortcuts/paste control disabled and no optional providers. `task` calls the shipped `taskPreset()` defaults, with no optional providers. Exact feature/options identities accompany each observation. This is a feature-cost experiment, not a like-for-like implementation comparison. Hardware, browser, viewport, source/toolchain, checkpoint, warmup/sample counts and method are fixed. Preset order is preregistered and fixed; order/thermal bias remains unexcluded. Raw pairs and medians are diagnostic, with no qualified tail inference.

After a new owning run, `node scripts/record-fitness-baseline.mjs --directory
<retained-output-directory>` verifies all current source/runtime/fixture pins and
updates the bounded baseline index. It preserves previous raw runs and the
independent optional-loading receipt; an incomplete run cannot replace the index.
Then run the canonical budgets suite. The mutable observation index is excluded
from executable source pins, avoiding a circular identity when recording output.

Each observation pins preregistered configuration/policy, executable source,
fixture, toolchain, CPU/memory/OS/browser, and retained runtime bytes. The existing
benchmark configuration remains byte-identical. The shared browser-size contract
owns gzip caps; legacy benchmark Brotli measurements are not Task cap evidence.
FIT-1.6's packed size proof remains prerequisite evidence only.

Remaining owning work: sufficient comparable tails and other shipped/high-risk optional presets;
uninstrumented engine-only attribution and actual OS composition; continuous selection/drag/scroll
frame/geometry and cancellation traces; actual optional highlighting/table/asset
workloads, changed-region/queue bounds; repeated disposal/canceled transfer/unload
resource counts and prereviewed memory/frame limits; packed cold/warm activation;
keyboard/touch/screen-reader/non-drag paths and named native/mobile text-service,
IME/candidate/accessibility/thermal traces. Physical or virtual target runtimes
are accepted under verification.md. Pending native records and prepared contract
providers stay unqualified. No publication or paid inference is part of this check.

Supported Task/Long replay is `ascii-overwrite-delete-restore-v1`: replace a nearby existing ASCII letter with x, measure its deletion, and restore the original letter outside that deletion window. Startup/history use the same overwrite policy. Exact corpus bytes are unchanged before and after every sample; overwrite holds UTF-8 size constant. This avoids requesting growth beyond the existing1MiB aggregate ownership bound at the exact Long size. Retained task-long-7 demonstrates the failed growth probe; overwrite observations do not qualify insertion growth beyond that bound.

`cargo run --release --locked --offline -p editac-core --example fitness-edit-cost
-- <retained-native-checkpoint.json>` attributes portable native anchor/preparation,
commit and projection costs on that exact checkpoint. It verifies corpus restoration
after eighteen overwrite/restore operations across start/middle/end blocks. This is
portable command timing, not a native control, IME, compositor or tail-latency proof.
The owning browser runner stops after the first failed scenario, retains its partial
observations and reports every unexecuted planned scenario as skipped.

The portable editor projection reuses one qualified v4/v5 replay for its ownership,
retained snapshot and editor metadata. A successful dirty inspection is memoized
until a real observed mutation; public reads retain the pending changed-node/range
evidence. Qualified mapping fixtures still own replay and snapshot serialization.
The Rust equivalence tests cover their nested-list/check/number metadata, unknown
marks, Unicode edits, structural replay, restore and malformed-input rejection;
the cache tests cover repeated local edits and deletion-only remote replay.

The opt-in `fitness-trace` Rust feature builds a separate `target/fitness-runtime` artifact outside package distribution.
Production bundles and byte measurements retain the default artifact. Only the
benchmark SDK applies fail-closed generated-FFI/SDK/renderer hooks. Every measured
typing and composition-finalization window retains up to512 numeric spans with
an explicit overflow count (any drop rejects admission). The exclusive timeline
partition counts nested work once: Rust bridge including JSON, generated FFI
residual, SDK residual, renderer residual and unattributed dispatch work. Timing
imports/hooks perturb these diagnostic observations; no overhead subtraction or
uninstrumented engine latency claim is made. The composition replay uses actual
input ownership and DOM mutation, asserts zero provisional commits, one final
commit and exact corpus restoration. Synthetic events cannot qualify OS IME,
candidate geometry or compositor presentation. Small quick samples still cannot
qualify p95/p99. Instrumented and production WASM are separately hashed/retained.

Composition samples alternate mapped character-data replacement and native
Range deletion/insertion that splits text nodes. Both use the same selected ASCII
overwrite and restore corpus bytes. Raw shape identities remain separate; these
small mixed-shape samples are not a comparable tail estimate. Native finalization
explicitly rebuilds the composing block's runs because native splits invalidate
cached positions. Ordinary text reconciliation retains its mapped nodes. Other blocks and their views retain identity.

`cargo run --release --locked --offline -p editac-core --example fitness-snapshot-cost
-- <retained-native-checkpoint.json>` measures qualified v5 replay and snapshot
serialization separately, without bridge/JSON clock hooks. It retains six raw
observations and the complete semantic snapshot. Baseline/candidate comparisons
must reuse exact checkpoint bytes, alternate process order, compare complete
snapshots and pin both executables. These few native samples cannot qualify
browser input tails or target-platform UI behavior. The indexed serializer keeps
parent lookup and ordered-sibling counting bounded without changing deleted,
checklist, nested-container or unknown-tuple semantics; the independent scan
oracle is in `crates/editac-core/tests/fitness_snapshot_metadata.rs`.

## PRF-02 browser gesture diagnostics

`node scripts/bench-gestures.mjs --seed-directory <retained-owning-directory> --output <unique-directory>` restores the exact Task/Long schema-v5 checkpoints with both public SDK presets. Build current WASM and packages first. The retained owning directory must contain `fixtures/{Task,Long}.checkpoint.json`; no provider or network input is used.

One canonical harness drives trusted Chromium mouse selection, selected-text drag canceled with Escape, and ordinary-pointer autoscroll through two nested host scrollports from both prose and the final code block. The selection/prose cases deliberately choose the narrowest interior glyph. Character Range rectangles supply integral pixels whose independent native caret hit is exactly the intended UTF-16 offset. Fractional glyph-midpoint controls retain trusted dispatched mouse coordinates, hit-tested endpoints and the resulting native selection before resetting for measurement. This exposes subpixel rounding and caret targeting differences without assuming an application mapping defect. Exact repaired anchors, selection focus and independent DOM Range length are admitted; native endpoint records share the 2,048-entry bound and overflow fails admission; no Shift modifier is used.

Prose autoscroll starts 320 px before the real full-corpus end; code autoscroll centers the final native code block. Positioning and fractional controls are outside measurement. No blocks or text are removed. Each gesture takes 120 pointer steps paced by actual browser animation callbacks. Raw animation-frame timestamps and separate callback execution clocks, application geometry/mapping work, scroll positions, separate long-task entries and trusted event identities are retained. There is no fixed 60 Hz timer. Cancellation verifies stable selection and scroll across two later 12-frame windows, unchanged complete fixture semantics, canceled native drag/no drop and stopped collector scheduling. Native drag consumes Escape before DOM keydown; trusted dragend with dropEffect none is its terminal observation.

The application-only bundle transform counts actual DOMSelection mapping and DOMRenderer positions/full-document fallbacks. Element/Range rectangle calls are observed only in the harness. Zero fallback scans and per-frame returned-position/geometry counts describe application work; browser-internal hit testing and compositor presentation are unobservable. Instrumentation never enters shipped packages. The profile preserves existing fitness limits and explicitly has no reviewed gesture-specific latency/geometry thresholds. These observations cannot admit full PRF-02/FIT-1.8 performance, accessibility, OS input or platform qualification.

A successful owning receipt may be pinned in `benchmarks/profiles/gesture-evidence.json`. Canonical budgets verify current source, fixture/preset/checkpoint, harness/WASM and receipt hashes, exact 16/16 counts, all four cases on four fixture/preset combinations, raw refresh/frame/long-task inputs, cancellation and cleanup. Contract negatives reject missing/synthetic/overflowed input, scan fallback, mutation, continued scrolling, missing drag and leaked resources. Failed owning directories remain retained; fix the corresponding implementation/setup before another feature run.

The earlier ordinary-pointer/code-start failures and narrower Shift/prose receipt remain immutable historical diagnostics. The current receipt must independently prove ordinary-pointer endpoints, code/prose nested scroll movement and cancellation in all four unchanged fixture/preset combinations before admission. Neither receipt qualifies gesture thresholds, browser internals, compositor presentation or full FIT-1.8 acceptance.

PRF-03 diagnostics use `node scripts/bench-services.mjs --seed-directory
<retained-owning-directory> --output <unique-directory>`. The same full Task/Long
checkpoints and baseline/Task presets run through the public editor, real WASM
engine, production service lifecycle, reference lookup and sync adapter/transport.
Host results are prepared deferred promises, including providers that ignore
abort. Raw observations retain 24-request admission/cancellation and resolver
storms, eight local and eight remote atomic replacements, patch and DOM mutation
IDs, sync frame bytes/queue snapshots, command and pump timings, convergence and
resource teardown. Replacement targets are recorded ASCII UTF-16 positions;
whole-corpus size stays constant, including Long at its existing text limit.
Each replacement is one public compound commit. Timing excludes anchor setup and
does not observe paint; no tail or performance qualification is inferred.
Highlight/asset/conversion adapters remain pending. Resource limits are fixed in
`services-v1.json` before measurement; performance thresholds remain unreviewed.

The monitor's native link/session integration changed broad source pins in older
browser receipts without changing the browser dependency closure. The bounded
`browser-source-reuse.json` policy admits only those exact before/after Git
identities: the native session manifest/module and its lock dependency edge.
All other old pins must still match; WASM dependencies exclude the session crate,
current production WASM bytes must match retained artifacts, and the gesture SDK
is rebuilt for byte identity. This preserves historical measurements without
asserting that a different executable was measured. Any further drift fails.

PRF-04 uses `node scripts/bench-workloads.mjs --output <unique-directory>`.
The fixed `workloads-v1.json` policy precedes measurement. Task/Long scales preserve
all 10,240/1,048,576 bytes of the frozen text generator when regrouped into one
very long logical line or eight mixed-direction blocks. Tables have 16/128 rows,
eight columns and 64 UTF-16 units per cell; Long reaches the actual renderer's
1,024-run bound. Four/32 image modules decode the retained local 1,024×1,024 RGBA
PNG through the real host policy. Each scale/workload restores one exact checkpoint
with both baseline/Task presets. No rows, code points or images are dropped.

Twelve raw replays retain full-text/table native Range endpoints, native table
control selections, atomic text replacement/restoration or real table-adapter
input/commit/restoration, image layout, two animation callbacks and separate long
tasks. Seeding, semantic oracles and heap collection remain outside timed replay.
These programmatic controls do not prove trusted input, compositor or OS behavior.
Raw order statistics describe these samples; their tails remain inconclusive and
performance/memory release limits remain unreviewed. Existing limits stay intact.

CDP heap/backing-storage samples use explicit mount/replay/disposal boundaries
without forced GC. Report observed maxima with harness allocations included;
these are neither continuous total-process peaks nor native image-decoder peaks.
Every complete semantic projection must match the independent generator after
restoration. Disposed editors, module views, asset sources, databases, browser and
server are checked. Canonical negative admission rejects truncation, mismatched
checkpoints, missing ranges/samples/memory, fake qualification and leaked resources.

The constructor keeps its 262,144-unit per-block limit. The long logical line is
seeded as safe <=131,072-unit chunks and joined through public commands before
measurement. Fragment byte admission remains unchanged. Table seeds include
the exact tab/newline fallback maintained by real table-cell commits. Public
content insertion's two empty editable boundary blocks stay in the semantic
oracle. Canonical object keys and adjacent equal-mark run coalescing remove only
nonsemantic serialization/seam differences; every value and distinct mark map
is preserved and raw initial run lengths/maps are retained. Preparation runs
in a separate closed browser context. Both fresh preset contexts initialize
WASM before the mount timer, and retain all twelve sequential replays. Two
animation callbacks may share a refresh timestamp; keep those raw duplicates
without inferring separate presented frames.

PRF-05 uses `node scripts/bench-lifecycle.mjs --seed-directory <retained-owning-directory> --output <unique-directory>`.
`lifecycle-v1.json` fixes Task/Long × baseline/Task, twelve cycles and a 200 ms
idle window before measurement. Each cycle proves a live paste target with an
actual committed paste/undo, cancels deferred clipboard preparation, unloads the
production resolver with an abort-ignoring prepared host, destroys the editor,
releases late completions and reopens acknowledged storage to check source
preservation. All databases are deleted, roots cleared and handles released.
Weak-reference probes record listener, timer, animation frame, observer and worker
registrations without retaining discarded targets. Post-GC CDP heap and DOM
samples cover browser backing-storage endpoints. Native/process/WASM peaks remain
unobserved.
Executable controls deliberately register every resource and run idle polling,
then require detection and cleanup before the fixed replay. Retired probe entries
are pruned; workers require explicit termination even after handle collection.
Observer accounting is conservative until disconnect (unobserve is not inferred).
Idle checks count scheduled callbacks, not event-driven browser internals, OS work,
property event handlers or unobserved ports. Optional providers are absent.
Memory plateau has no reviewed limit and remains inconclusive. Canonical admission
rejects missing cycles, resource leaks, idle polling, late mutation, lost recovery,
mutated artifacts and invented qualification; this receipt cannot close FIT-1.8.
