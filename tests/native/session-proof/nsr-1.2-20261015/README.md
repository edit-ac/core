# Actual generated Swift shared Session qualification

Original parent: NSR-1.2. This proof extends the one existing UniFFI library from the actual shared `Session<Arc<NativeStore>>` implemented in NSR-1.1. It does not substitute NativeEngine for Session. `delivery.json` pins the source commit, exact changed files, generated Swift/C/module-map/Kotlin artifacts, native library, executables, receipts and retained failures.

Final results: generated interface audit **55/55**; actual macOS aarch64 Swift **33/33 executions** (12 Session semantic cases, the same 12 under generated-source instrumentation plus one cleanup case, and 8 legacy NativeEngine cases); exact consumed-contract applicability **25/25**. All final counts have zero failures/skips. There are 21 distinct Swift case IDs across semantic, cleanup and legacy families, not 33 unique scenarios. Measurements observed 349 returned buffers lifted/freed with no outstanding tracked buffer and 19 actual foreign-reference frees. Instrumentation modifies only a disposable generated-source copy; the semantic executable uses unmodified generator output. No allocation-total, performance or whole-process leak claim follows.

The harness executes real create/open/durable commit/history/reopen, typed missing-store/wrong-identity/revision/permission/plan failures, UTF-16 atomic rejection, detached owned values, cancellation, replica-scoped plans, independent foreign aliases and ARC last-reference teardown. Parallel callers test exactly-once plan consumption and legal cancel/commit/dispose order; reopen checks durable results after disposal. All nine non-dispose Session methods return typed Disposed after alias-wide disposal. This synchronous boundary has no foreign callback interface; AppKit scheduling and no callback after view disposal remain original DSK-1.3 work.

Retained failures: initial generator audit 54/55 because Swift escapes `open`; attempt-1 Swift compile failed for two missing `try` markers (zero runtime cases); attempt-2 runtime 11/12 because the test's first staged edit moved the intended surrogate split. The fixture now matches the established Rust staged-offset case and expects the actual typed Engine failure. Initial impact audit 24/25 compared a counts record including an extra `newSession` field as an exact dictionary; repaired to compare required count fields. These are fixture/audit repairs, not concealed provider or semantic failures. Three Swift WeakMutability warnings per Session compile are retained; they are not failures/skips.

`entry-impact.json` binds preflight owning receipts, the LQR v3 supplement and copied historical actual-main admission. It verifies no 12/07/13/21 consumed implementation change from integrated baseline c4fcd5e, maps the additive native consumer, reuses the exact NSR-1.1 Rust/public-JS compatibility proof and supplies new Swift boundary proof. Historical LQR admission is not represented as current-main NSR admission. Unchanged upstream browser/module/diff/extension suites were not rerun. No ABI or client-contract change was needed in NSR-1.2.

Reproduce from the workspace root with explicit toolchain PATH:

```sh
export PATH=/Users/bpstr/.nvm/versions/node/v24.19.0/bin:/Users/bpstr/.cargo/bin:$PATH
python3 core/tests/native/bounded-bindings.py --output /absolute/new/nsr-proof
python3 core/tests/native/session-swift.py --output /absolute/new/nsr-proof
```

The impact audit uses this committed proof and designated monitor admission: `python3 core/tests/native/session-impact.py`. Preserve existing attempts when reproducing. Native library/executables are hashed and reproducible; task-temporary executables were removed after execution. SQLite fixtures and raw failures are retained. No network/provider/credential transport is involved.

Implemented/verified locally, not main-integrated or deployed. NSR-1.3 belongs to the non-worker monitor under integration.lock, including qualified merge, both-lane sync and original18 entry revalidation/restore. Original DSK-1.3, IME, full SDK/platform and release gates remain open. No paid inference, external messages, push/publication or controller operations occurred.
