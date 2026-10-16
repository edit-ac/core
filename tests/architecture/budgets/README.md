# Feature-aware architecture fitness

`node scripts/check-architecture.mjs --suite budgets` validates the reviewed
`benchmarks/profiles/fitness-v1.json` policy and content-addressed baseline index.
It rejects changed source/artifacts, missing raw samples, incomparable inputs,
unknown profiles, skipped/failed cases, post-hoc limits and prepared runtime
claims. The suite is an admission contract with actual baseline observations;
a passing test receipt does not qualify all PRF cases or a release profile.

The fitness producer validates the reviewed profile against the current verification
policy before building or measuring. Each new run retains `policy/verification.md`
and its hash/review identity; admission requires those exact bytes and a review
before the measurement timestamp. Policy amendments require an applicability
review at unchanged limits and new execution, never relabeling historical samples.

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

The producer validates the existing fitness profile against current verification policy before browser launch, retains the exact reviewed policy bytes, and rechecks source/policy identities after measurement. Canonical admission rejects absent/stale policy, changed review identity and pre-review measurements. A successful owning receipt may be pinned in `benchmarks/profiles/gesture-evidence.json`. Canonical budgets verify current source, fixture/preset/checkpoint, harness/WASM and receipt hashes, exact 16/16 counts, all four cases on four fixture/preset combinations, raw refresh/frame/long-task inputs, cancellation and cleanup. Contract negatives reject missing/synthetic/overflowed input, scan fallback, mutation, continued scrolling, missing drag and leaked resources. Failed owning directories remain retained; fix the corresponding implementation/setup before another feature run.

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

PRF-06 uses `node scripts/bench-loading.mjs --seed-directory <retained-owning-directory> --output <unique-directory>`.

`EDITAC_LOADING_RENDER_TRACE=1` adds Chromium main-thread `UpdateLayoutTree`,
`Layout`, `PrePaint`, `Paint` and `Layerize` events to that same packed replay.
Only closed event names and numeric navigation-relative start/duration clocks
are retained; trace arguments, stacks, URLs and content are discarded. The
window ends at the existing second RAF observation. Trace collection adds
overhead and does not establish compositor presentation. Event costs are
inclusive within each kind; do not add nested kinds as an exclusive total.
Pair with `EDITAC_LOADING_COMMAND_TRACE=1` to correlate recovery/surface/frame
milestones, and retain a separate production matrix. The profile, fixtures,
sample counts, accepted edit, exact restoration and limits are unchanged.
`tests/architecture/budgets/rendering.test.mjs` admits the pinned diagnostic
matrix and rejects missing, mislabeled and content-bearing rendering evidence.
The fixed `loading-v1.json` policy retains twelve cold/warm pairs per Task/Long ×
baseline/Task combination. The shared SDK-1.8 size producer packs and installs
public artifacts into a clean offline consumer, audits every input and required
lazy root, and applies the existing gzip hard caps and preferred sizes. Both
presets use this same public bundle; runtime feature costs are separate from
artifact delivery costs. No optional provider is enabled or qualified.

Each pair opens a fresh incognito context, transfers its exact checkpoint,
acknowledges a public edit/restoration, destroys the editor, then navigates in
the same context to restore IndexedDB with the HTTP cache warm. Raw resource
entries prove cold delivery and warm cache hits; CDP script and best-effort coverage
traces accompany the static packed import audit. Storage is deleted and contexts
are closed after every pair. Timings include the small fixture projection oracle
module, page instrumentation and browser scheduling. These are navigation-to-ready,
first-animation-frame and public-command acceptance observations, not trusted
input, compositor, OS-process cold start or uninstrumented release qualification.
The preserved startup targets remain diagnostic and misses must stay visible.
The 100-sample tail minimum stays unchanged; twelve samples are inconclusive.
Canonical admission rejects missing samples, cache/evaluation proof, optional
resources, changed artifacts/source, relaxed limits, lost recovery and leaks.

PRF-07 native diagnostic: `python3 tests/native/ios-fitness.py --output
architecture-results/fit-1.8-20261015/native-input-N` builds the real native FFI in
release mode and a standalone UIKit app plus XCTest UI runner. A private iPhone17 /
iOS26.5 Simulator receives twelve OS keyboard edits. The adapter commits Rust
before bounded UTF-16 projection; XCTest queries/actions the OS accessibility tree.
The app records keyboard notifications, UITextInput caret/marked rectangles,
CADisplayLink callbacks, native commit intervals, locale and simulator thermal
metadata, pauses measurement callbacks whenever no input awaits a frame, then verifies marked-text cancellation, source-preserving checkpoint
reopen and disposal. The fixed Unicode corpus and profile are frozen before runs.

This is one bounded diagnostic, with no SDK/support claim. Callback timing excludes
XCTest dispatch and cannot prove compositor paint. Native marked-text API execution
is not CJK candidate selection. XCTest accessibility is not VoiceOver exploration.
Simulator thermal state proves no physical thermal behavior. Twelve samples leave
p95/p99 null under the unchanged100-sample minimum; full Task/Long and remaining PRF-07
qualification stay open. Canonical budgets admits exact native receipt/source/artifact
pins and rejects missing, mutated, skipped or relabeled observations.

Fresh native runs also retain the exact iOS-simulator normal/build dependency
and feature graph before and after the locked offline release build, compiler
identity, linked static library and app executable. Admission compares the graph
and compiler with the current checkout/toolchain and verifies every artifact.
Workspace changes do not grant a source exception or permit relabeling previous
measurements. Changed native inputs require a fresh owning execution here.
Both drivers tap the native text view and require its UIKit editing-begin
callback to observe first-responder ownership and the expected input mode before
typing. A button tap or a cached visible keyboard does not establish readiness.
The append selection is installed after UIKit finishes handling the focus tap;
otherwise the native tap can overwrite selection and compose before the seed.
Automatic capitalization is disabled for the reviewed lowercase key sequence.
The CJK driver requires the Pinyin input mode. Both drivers press each hittable OS key
for 0.1 seconds. ASCII observations assert native focus before/after commit and
at the display callback; CJK marked text and the selected candidate must still
be observed. Readiness and key dispatch alone cannot pass either scenario.

The same owning command additionally runs the frozen `profile.cjk` scenario on
that private simulator, configured with English and Simplified Chinese Pinyin.
An instrumented UITextView observes outermost actual OS marked/unmark/insert
calls. Provisional text stays in UIKit; selecting `你` commits one append through
the generated Swift/Rust boundary. XCTest taps the native `n`,`i` keyboard keys,
queries the candidate's OS accessibility frame and action, selects it, then types
`h`,`a`,`o` and invokes the host's cancellation action. Intermediate accessibility
queries verify the committed source never contains provisional text. Native
observations include marked/caret geometry, exact checkpoint recovery, thermal
state and one commit/display callback. The candidate screenshot and accessibility
tree are retained separately from native anchor geometry. This qualifies only the
named diagnostic; one commit cannot qualify tails, all CJK input, VoiceOver or a
native SDK. Canonical admission requires both the retained twelve-edit ASCII
scenario and this CJK scenario, rejecting missing, skipped or corrupted evidence.

CJK timings begin in the public native callback after UIKit mutates provisional
text, then cover Rust acknowledgment and the next display callback. They exclude
the preceding OS projection and cannot measure end-to-visible latency. The
independent XCTest candidate dispatch/accessibility interval includes transport
and is not joined to the app clock. Raw callback diagnostics keep tails null.


The same owning command also executes named Task and Long workloads on that
private iOS simulator. `scripts/prepare-native-workloads.mjs` generates the exact
existing 20-block/10,240-byte and 2,000-block/1,048,576-byte schema-v5 corpora,
checks the independent semantic oracle and retains the producer executable,
checkpoints, full snapshots and logs. The app restores the complete native
engine state, verifies every generated block and projects all block text joined
by newlines into TextKit1. Mixed-block native rendering remains unqualified.

XCTest presses twelve actual English OS keys per size, overwriting the last
ASCII letter of the final block at a fixed UTF-16 range. This matches the browser
corpus-bound policy: Long already reaches the engine's 1 MiB text cap, so an append
is correctly rejected. Corpus bytes remain constant; no resource limit is raised. Raw native observations
separate engine acknowledgment, bounded TextStorage overwrite and the next display
callback's forced layout. Every edit must change exactly one block and preserve
focus. All generated source text and the full mixed snapshot must survive
checkpoint/reopen exactly. Comparison excludes only the session-local read
fields `revision`, `changedNodes` and `touchedRanges`; all remaining fields,
including identity, full visible nodes/runs/spans/attributes and recovery, must
match. Both unmodified raw snapshots are retained. Final/reopened snapshots, checkpoint bytes and
metadata are retained. `mach_task_basic_info` records raw resident/virtual bytes
before restore, after initial projection, after each edit and around disposal.
These samples are not continuous peaks, footprint or plateau proof. The profile
preserves the phone 33 ms target and minimum 100 tail samples; twelve-edit summaries
remain inconclusive. No compositor, full SDK, VoiceOver or physical thermal claim
follows from this text-service envelope. Canonical admission rejects incomplete
workload/corpus/resource/restoration evidence in addition to ASCII/Pinyin checks.

PRF-07 causal scaling attribution uses an explicit native `fitness-trace` feature.
The default ABI artifact has no diagnostic result fields. The instrumented build
retains the same generated Swift ABI and semantic editor command path, but adds
numeric Rust prepare, commit, detached-patch construction and JSON durations in
`resultJson.fitnessTrace`. Workload samples split both actual anchor calls,
request construction, enclosing synchronous FFI call, Swift decode, TextStorage
projection, callback wait and TextKit layout. Request construction and callback
wait are retained separately from engine, projection and layout work. The FFI residual includes executor scheduling,
transfer and diagnostic encoding overhead; no zero-copy or uninstrumented latency
claim follows. Admission rejects absent, reversed, negative or impossible spans.

The shared editor prepares its first text command read-only against the unchanged
original document, then rebinds and applies the prepared edits to its disposable
batch. Later commands still prepare against staged state. This removes one full
restore/validation without changing the final batch validation, exact-byte stale
check, atomic commit, history or detached patch. Unit regressions compare encoded
updates against the staged path on v4/v5 and exercise later rejection, stale plans,
Unicode and undo/redo. `cargo run --release --locked --offline -p editac-ffi
--features fitness-trace --example fitness-batch-cost -- <native-checkpoint.json>`
retains host causal spans for the same twelve fixed-range edits. Host observations
and instrumented target observations remain separate; twelve samples cannot
qualify tails or the full performance/accessibility gate.

The native workload driver requests UIKit focus through an actual app button and
waits for the native first-responder selection handshake before OS key events.
This avoids inferring focus from a tap in a large scrolled text surface. The
ASCII scenario uses its existing focus action. Failed initial tap-only execution
and screenshots remain retained; no input observations are prepared or replayed.
The focus preflight confirms foreground activation and allows at most three
actual 100ms button presses, each with a five-second native acknowledgment wait.
Focus-request counters are retained before requesting UIKit focus; measured
ASCII/Task/Long admission requires a nonzero bounded acknowledgment. These
pre-measurement retries do not retry or substitute any measured edit.
On a fresh simulator, dismissing the OS swipe tutorial is followed by a new
UIKit text-service binding through the same focus button before the first key.
The ASCII acknowledgment is retained in the committed-source case observation;
workload acknowledgments are retained on their workload records. Negative ASCII
and workload controls first validate their unchanged current runtime contrast,
then mutate one fault. The canonical inventory retains their rejection reasons;
trace-field controls require the intended timing/trace rejection specifically.

The `navigation-phases-v1` loading attribution retains contiguous raw intervals
from navigation through flush. It separates checkpoint fetch/decode/publish,
editor creation and recovery/surface readiness, double RAF, independent oracle
reads/projection/hashes, anchor creation, public commit and anchor release, and
exact restoration. The summary exposes oracle overhead and public edit duration
without subtracting either from the preserved accepted-edit budget. Admission
rejects absent, reordered, overlapping, gapped or metric-inconsistent intervals.
Module timing includes transfer/evaluation; WASM init includes fetch/compile/
instantiate and editor-ready includes recovery/surface binding. These combined
phases require further instrumentation before attributing their internal costs.

PRF-06 internal preparation diagnostics use `EDITAC_LOADING_COMMAND_TRACE=1
EDITAC_LOADING_ENGINE_TRACE=1` after `node scripts/build-wasm.mjs --fitness`.
The external packed SDK/storage/renderer remain the installed package closure;
only the derivative's generated engine glue/WASM uses `fitness-trace`. Retained
artifacts identify both runtimes. Production sizes and timings always use the
default WASM separately. Bounded numeric spans partition baseline encoding,
stage replay, projection setup, command planning, final validation, staged size
and update encoding. Planning includes actual lazy projection/text work; setup
alone does not measure a projection read. Nested staged-size spans isolate that
cost. All clock/callback overhead is included, with no subtraction or release
latency claim. Admission requires every phase within the prepare boundary and
rejects missing/overlapping/mislabeled phases, payload fields and dropped spans.
The text-only path retains text admission and the final qualified hierarchy,
immutable-structure and exact-size checks while avoiding redundant full replay
between text steps. Structural commands still validate their intermediate view.

PRF-06 final validation observations partition the qualified staged projection,
selection/hierarchy checks, immutable base maps, before/after source ownership,
and retained-source identity comparison. All six numeric subphases must occur
once, in order, inside validation; payloads, overlaps and missing phases fail
admission. Production WASM remains free of observer callbacks. Source-bound raw
records distinguish full ownership replay from the optimized identity traversal.

The editor's final ProjectionIndex admits the staged document before immutable
comparison. Its internal validator re-reads the observed index so a mutation
cannot reuse stale admission, shares the full validator's immutable base-map
checks, and compares every original XmlText key and nested CRDT BranchID directly.
The owning Document has already admitted the original replica. The generic full
replay validator remains in place for other admission/history paths. Replaced
sources, missing sources and immutable base changes still reject; no source text,
marks or replay data are omitted from stage qualification. v4/v5 regressions
compare both validators after Unicode edits and hostile changes, including changes
after cache population. This optimization changes no encoded edit or public API.

The production WASM bridge retains at most one serialized settled snapshot per
engine. Its key is the owning Document's local revision, including local, remote
and history writes. The first read still consumes and returns projection change
diagnostics; cached reads have empty changed-node and touched-range arrays, just
as a fresh settled projection read does. Public JavaScript reads parse owned
objects, so caller mutation cannot poison the retained string. Dropping the engine
drops this cache. The retained bytes are additional memory, not a peak/plateau
qualification. Native bridge and compiled-WASM regressions cover repeated reads,
UTF-16 replacement, structural/history/remote invalidation, rejection, observer
reentrancy and disposal. Production loading measurements include the cache cost
and retain the complete fixture, independent oracle reads and original limits.

Editor preparation seeds its disposable stage from the live projection admitted
for the exact checkpoint just applied to that stage. This private transfer is
valid only before either replica changes. It inspects without consuming live
changed-node/range evidence, clones immutable derived values, and rebinds every
source text handle after checking its CRDT identity. New stage observers own all
later invalidation. Text-only changes reuse clean source runs after full ownership
replay; structural changes still rebuild conservatively. Final hierarchy,
immutable structure, selection, encoded-size and stale-plan checks remain in
place. Independent v4/v5 fresh-index tests cover unread, settled and locally or
remotely dirty originals, stage-only Unicode/deletion/structural changes, failed
admission and mismatched source identities. Existing encoded-update, history,
packed restoration and startup checks remain required; this prerequisite does
not qualify original startup limits or the complete performance parent.

Changed-revision wire reads serialize the projection only once. The writer
records byte spans for nonempty root `changedNodes` and `touchedRanges` values;
the settled cache replaces exactly those spans with empty arrays. It never
searches document text or nested attributes for field names. An independent
`serde_json::Value` oracle checks both responses byte for byte, including nested
diagnostic-like keys, escaped strings, Unicode and each empty/nonempty delta
combination. This removes the second full run traversal while preserving the
first-read diagnostics and the existing detached-read/invalidation contract.

Surface input activation reuses the renderer's admitted projection rather than
reading and retaining another full engine snapshot. The input text lookup reads
model runs, including the latest deferred patch while composition holds a DOM
block. Removed/hidden nodes yield no baseline; uncommitted native DOM mutations
cannot become the source of truth. The lookup belongs to the same live engine
and becomes empty when the renderer is disposed. This removes the input adapter's
duplicate text map and patch subscription. Packed browser regressions compare the
lookup with independent engine reads, exercise held updates/removal, and commit
observer-only native input. The full loading producer still measures the original
Task/Long corpus, oracle work, exact restoration and unchanged startup limits;
this optimization alone does not qualify startup or the full performance gate.


The PRF-05 lifecycle producer also compiles the test-only macOS
`scripts/process-memory.c` helper and samples the captured browser process tree
every 20 ms in a separate process. `proc_pid_rusage(RUSAGE_INFO_V4)` supplies
resident bytes, physical footprint and OS-maintained lifetime maximum physical
footprint. The helper retains monotonic sample windows and process start identities;
CDP process-role boundaries identify the browser and renderer. Admission rejects
missing/reused identities, unavailable counters, gaps over the preregistered
250 ms coverage ceiling, truncated streams and incorrect summaries. This ceiling
is a measurement-coverage condition, not a performance or memory budget.

A native control touches and frees 48 MiB before reading the OS counter, requiring
the lifetime maximum to retain that otherwise missed allocation. The producer
keeps each raw stream, helper binary/compiler identity and complete fixed-corpus
lifecycle/restoration evidence. The collector is stopped even when a cycle fails;
its timeout and closed input also prevent an orphaned indefinite sampler. Other
platforms fail this named method rather than substituting prepared observations.

The sampled tree high-water sums current process footprints at each sample; it
is not the sum of individual lifetime maxima. Lifetime maxima include each
process's history before the cycle. Enumeration is sequential and sampling can
miss short-lived processes; neither measure qualifies a simultaneous browser-tree,
cycle-local or JS-allocation true peak. Post-disposal GC samples and seven live
JS/backing/DOM phases remain separate. Plateau limits remain null/unreviewed;
optional decoders and native editor runtimes remain unqualified.

Each process sample retains the initial current/lifetime values and a second
ordered OS peak read with its process start identity. Three samples in the
first complete child-tree run reported current footprint 16 KiB above the first
lifetime counter; that failed run remains retained. The second read must confirm
a peak at least as large as the first current value and preserve process identity.
Admission rejects unresolved inconsistency, missing confirmation and decreasing
counters. The raw first counters are never overwritten; summaries count these
initial inconsistencies. This protocol still cannot establish cycle-local or
simultaneous browser-tree peak qualification.

## Table input and accessibility observations

`node scripts/bench-workloads.mjs --table-accessibility --output <unique-directory>` extends the same fixed 16-case PRF-04 corpus. The separately reviewed `table-accessibility-v1.json` policy adds twelve trusted keyboard/mouse/emulated-touch replays per table configuration, full initial/final Chromium AX cell names/values and a fresh persisted reopen. These extra observations run after the existing programmatic replay samples; AX is enabled before navigation for table cases. Their timing includes test orchestration and cannot qualify compositor, screen-reader, physical-touch or tail performance. The default workload command retains its original policy and observations.

Keep failed owning output, even when partial input-only observations pass. `table-accessibility-evidence.json` identifies that output; focused `table-accessibility.test.mjs` checks its pins and detector sensitivity, admits input-only observations separately and rejects incomplete full admission. Passing these contract checks does not turn a failed owning matrix into acceptance. Reopen must use the actual journal, including covered entries; never truncate it, widen restore limits or substitute an exported checkpoint to manufacture success.
