# Browser entry prerequisite fixture

`tests/browser/entry.spec.ts` packs the actual built `@edit-ac/core`, unpacks it
outside the checkout, and serves that package's JavaScript and WASM. The adapter
uses production IndexedDB checkpoint/journal storage, Web Locks writer isolation
and the local-storage lifecycle subscription. There is one Rust/Yrs replica.

The fixture's `ready` flag means explicit semantic test commands can run after
authoritative recovery and persistence attachment. Its projection stays
read-only. Full editor readiness additionally requires the rendering, selection
and input gates in WEB-1.2–WEB-1.10; this fixture does not qualify DOM input,
composition, real devices or a release.

The checks cover checkpoint plus journal-tail recovery, UTF-16 stable anchors,
scoped update patches, transaction-completed local flush and a second restore.
A held real WASM fetch proves commands remain blocked during initialization.
Missing WASM, checkpoint or writer isolation leaves an accessible recovery status
and rejects edits. Recoverable prerequisite failures can be retried without
reimporting initial content. Failed recovery releases opened storage resources.

Build with `npm run build:wasm` and `npm run build`. Run the narrow packed-core
check with `node --test --test-name-pattern='packed core restores'
tests/browser/entry.spec.ts`, then `npm run test:browser -- recovery` for all
entry checks and the existing real process-crash recovery suite. Use Node
24.19.0 and rustup's repository-pinned Rust 1.97.1; Homebrew Rust has a separate
sysroot and may lack its WASM target. No providers or external service transports
are used.

`EDITAC_ENTRY_OUTPUT` selects the durable pack, case facts and teardown evidence
directory. `EDITAC_RECOVERY_OUTPUT` selects the crash-suite evidence directory.
Test teardown closes browser controllers and server listeners and removes the
temporary unpacked consumer; the evidence tarball is preserved.
