# SYN-1.7 offline recovery evidence

Incomplete: the canonical two-browser Rust/Yjs convergence check exposed a reopened SYN-1.3 prerequisite. Build passes. Both canonical runs execute four cases: three relay/browser commit-fault cases pass, one convergence case fails, zero skips/cancellations. The first failure was a repaired fixture ordering oracle; the second is the actual dependency-order receive failure. Do not rerun the second unchanged.

See `receipt.json` for commands/counts and cleanup; `run-2/harness.json` for actual client/relay/process facts and 24 archived matching source/build/fixture hashes; `frame-dependencies.json` and binary frames for the missing clock-0 predecessor. Service tests prove real loopback HTTP, child-process SQLite commit/crash/restart, IndexedDB outbox acknowledgment and browser process termination/restoration. Baseline traffic never claims remote durability. Prepared grants only; no deployment, paid inference or power-loss qualification.

Next bounded parent: SYN-1.3 causal dependency buffering/reconciliation, preserving strict malformed-frame rejection and bounded queues. SYN-1.7 stays open until its own entire canonical proof passes after that prerequisite repair. All 44 recorded processes and listeners are gone; disposable scratch removed, durable evidence retained, 19 GiB free.
