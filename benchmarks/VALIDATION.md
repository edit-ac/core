# Initial local validation — 2026-10-13

Source revision: `f24b52043e4b7b429d81da0f2a2371635c332475`, including the existing
uncommitted SDK/framework work. Node 24.19.0 and the locked Playwright toolchain
were used. These results are development evidence, not release qualification.

- Benchmark contracts, large-update recovery and existing WASM update/input
  guards: **40 passed, 0 failed, 0 skipped**.
- Native patch/math/module-registry fixture checks: **38 passed, 0 failed,
  0 skipped**.
- Broad regression run: **789 executed, 786 passed, 3 failed, 0 skipped,
  0 cancelled**. Receipt: `regression-results/2026-10-13T10-34-21.757Z/receipt.json`.
- Workflow YAML and all embedded shell steps parsed successfully. The hosted
  GitHub workflow has not been executed by this change.
- Quick browser benchmark: **8/8 scenarios passed**, with **60 metrics** and
  no missing samples or browser errors. All task-owned controllers/listeners
  closed. Report: `benchmark-results/validated/summary.md`.
- Performance budgets remain breached: large start typing p95 **366.6 ms**,
  structured end typing p95 **2607.9 ms**, full bundle **654.2 KiB Brotli**.
  These are quick diagnostics, not the accepted five-run CI baseline.

The three failed editing cases remain hard failures; the runner does not exclude
or waive them:

| File | Failed case |
| --- | --- |
| `tests/browser/history-selection.spec.ts` | Undo paragraph creation restores the stored heading-end selection |
| `tests/browser/input-policy.spec.ts` | Composition end before commit Enter does not split; keyup releases the next deliberate Enter |
| `tests/browser/input-policy.spec.ts` | Commit-key suppression expires at a dispatcher boundary when no keyup arrives |

The new recovery tests reproduce large binary journal replay and preserve the
ordinary metadata structure bound. The fix counts already copied/validated
binary payloads separately from caller JSON structure, retains the 16 MiB byte
limit and the native 2 MiB request limit, and rejects oversized journals before
expanding their arrays.

The benchmark measures a 100k-character deletion within one text owner. A single
fragment request deleting the whole mixed paragraph/list/code document rejected
with `InvalidCommand`; the failed experiment remains in
`benchmark-results/validation-final/`. Memory editing/cycles use a fresh versioned
fixture, keeping the large-operation journal separate from the memory workload.

Earlier failed runs and setup failures are retained in the ignored result
directories. Quick results cannot establish the five-run performance baseline.
Tiptap/Lexical comparisons, table-heavy fixtures and frame/virtualization
profiling remain outside this initial implementation. Budgets have not been
raised to make the existing editor pass.
