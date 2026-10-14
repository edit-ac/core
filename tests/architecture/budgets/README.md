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
