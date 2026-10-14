# Feature-aware architecture fitness

`node scripts/check-architecture.mjs --suite budgets` validates the reviewed
`benchmarks/profiles/fitness-v1.json` policy and content-addressed baseline index.
It rejects changed source/artifacts, missing raw samples, incomparable inputs,
unknown profiles, skipped/failed cases, post-hoc limits and prepared runtime
claims. The suite is an admission contract with actual baseline observations;
a passing test receipt does not qualify all PRF cases or a release profile.

The owning baseline command is the existing `npm run bench -- --fitness --quick
--fixtures small,medium --output <unique-directory>`. It rebuilds the real
Rust/WASM engine and browser SDK and uses deterministic document checkpoints,
IndexedDB recovery and the real input/renderer lifecycle. `--fitness` adds raw
synthetic dispatch, forced-layout and two-animation-frame timings, DOM mutation
scope, long tasks and repeated mount/dispose heap/surface observations. Keep the
endpoint separate from compositor presentation and real OS/IME input. Forced GC
occurs outside latency windows. These small samples are diagnostic; p95/p99 are
inconclusive. Do not substitute old small/medium identities for Task/Long.

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

Remaining owning work: controlled Task/Long baseline and official presets;
engine/FFI/render and composition attribution; continuous selection/drag/scroll
frame/geometry and cancellation traces; actual optional highlighting/table/asset
workloads, changed-region/queue bounds; repeated disposal/canceled transfer/unload
resource counts and prereviewed memory/frame limits; packed cold/warm activation;
keyboard/touch/screen-reader/non-drag paths and named native/mobile text-service,
IME/candidate/accessibility/thermal traces. Physical or virtual target runtimes
are accepted under verification.md. Pending native records and prepared contract
providers stay unqualified. No publication or paid inference is part of this check.
