# Local revision review

This opt-in page uses the installed public core/WASM and web packages. Existing task editor routes do not enable it.

Use Node from `.node-version` (24.19.0), then from `core` run:

```sh
node examples/task-editor/revision-review-product.mjs
```

The launcher prepares an offline installed consumer and prints its local URL and PID. Ctrl+C stops the server. `EDITAC_PRODUCT_PACK_RECEIPT=/absolute/path/to/receipt.json` may reuse byte-authenticated core/web tarballs when the harness verifies unchanged committed SDK inputs; it does not reuse browser outcomes.

The task and comment open simultaneously with distinct local identities, databases and bounded memory stores. Each has its own readonly toggle, capture/inspection/comparison controls, and close/reopen controls. Closing flushes and disposes only that instance. Reopening recovers its saved document with a fresh empty capture store; the sibling remains usable. Foreign handles are unavailable, and foreign identity/module access is incompatible. Each instance also has its own supported plain-text restore preview, confirmation and cancellation controls.

Edit either live document, save locally to confirm the journal flush, enter a name, and choose **Capture current state**. **Inspect** shows the existing public historical presenter, with immutable semantic content/hash and unknown provenance. Inspection leaves the live editor alone. Captures are explicit, decrypted memory: 3 retained captures, 96 KiB total and 48 KiB per capture including metadata. FIFO eviction removes older captures; an oversized capture is rejected without eviction. No capture is made while typing. Reload loses captures but reopens saved live content from local IndexedDB. This does not provide durable archival history, original source spelling, authentication, or global causal order.

Focused deterministic browser checks:

```sh
node tests/scenarios/revision-review-product.mjs capture
node tests/scenarios/revision-review-product.mjs scope
node tests/scenarios/revision-review-product.mjs compare
node tests/scenarios/revision-review-product.mjs restore
node tests/scenarios/revision-review-product.mjs conflicts
```

This executes Chromium, Firefox and WebKit against one pinned installed site, with independent public-engine and raw readonly IndexedDB observations. Receipts, screenshots, package/fixture/WASM hashes and full logs are written under `../architecture/evidence/revision-review-product-20261019/rvp-1.1/`. Scope evidence is under `rvp-1.3/`. Choose a **Before capture** and **After capture**, then **Compare captures**. The public semantic comparison model displays content, formatting, attributes and inert opaque data with unknown provenance. Use its unified, inline or side-by-side controls; comparison and inspection do not change the live engine or saved journal. Values are clipped visibly at 1,024 UTF-16 units by the public presenter. Pruning a selected capture removes the stale comparison and explains how to recover; select an available capture or capture again. Exact source spelling and general restoration are not claimed. Comparison evidence is under `rvp-1.2/`. To restore supported same-structure unmarked text, inspect a capture and choose **Preview restore as new edit**. The preview leaves live content unchanged. **Cancel restore preview** discards it; **Apply restore as new edit** revalidates and commits through the same storage owner, preserving source/node identity and one isolated undo group. Save locally confirms the journal flush. Unsupported structure or formatting remains a visible conflict. Restore evidence is under `rvp-2.1/`; acceptance is tracked in `02-safe-restore-progress.md`.

For unchanged compiled SDK inputs, `EDITAC_REVISION_SDK_RECEIPT=/absolute/path/to/receipt.json` reuses authenticated installed core/web artifacts while preparing fresh owned fixtures. It preserves the original package source/hash, rejects changed compilation inputs and permits only product fixtures and explicitly listed standalone proof scripts as non-compilation differences. `EDITAC_PRODUCT_SITE_RECEIPT` can then share the exact new installed site across related groups; browser cases execute afresh. New SDK API changes require new packed/installed packages rather than receipt relabeling. Per-group default evidence paths use the scenario parent ID.

For a qualified shared-owner return, set `EDITAC_REVISION_OWNER_INPUTS=/absolute/path/to/inputs.json` (and `EDITAC_REVISION_ARCHITECTURE` if the contract checkout is elsewhere). Preparation authenticates every owner source pin, installs the exact archived core/web packages offline, verifies every installed member and the WASM hash, then composes fresh pinned product fixtures. Mutable local dist is never substituted. Browser outcomes execute afresh.

Restore previews expire when readonly changes, when canceled, or when the review closes. Returning to writable mode requires a new explicit preview. A stale or denied restore displays its reason and the supplied base/current/proposed recovery snapshots; unsupported formatting, structure and opaque data remain intact. Host rejection reports the actual post-call state and does not claim rollback. Conflict evidence is under `rvp-2.2/`.

Use **Export recovery** to download the current document checkpoint and unsaved updates, with binary fields preserved. The export belongs to that task or comment only; temporary captures are excluded. Exporting does not confirm a local save or remote durability. Keep the page open after a save or export failure. Failed closing retains the live owner, editable view, captures and recovery; opening failures permit an explicit reopen retry without reseeding.

The dedicated `reopen` scenario checks full reload after edits and accepted restores, empty capture lists, storage denial, recovery bytes and retry. Current installed-owner limitation: after a journal append fails, repeated `flush()` still rejects its retained completion promise even when storage is available again. The UI retains recovery and exposes Save locally for a retry attempt, but successful persistence of those failed writes requires a qualified public owner repair. This unmet original RVP-2.3 predicate remains open; do not reload an unsaved live document before retaining recovery.

Review controls use the browser’s native Tab, Enter, Space and select keys (Option-Tab includes buttons in macOS WebKit). Inspect/capture moves focus to historical details; Close capture details returns to its Capture or Inspect invoker. Preview moves focus to the restore region; cancel and confirmation return to a fresh preview control. Compare moves focus into comparison; Close comparison returns to Compare captures. Layout controls retain focus after presenter rerenders. Readonly still permits capture/compare, but has no restore preview or confirmation; cancel is enabled only for a live preview. Visible focus indicators and bounded status text are browser behavior, without an OS or assistive-technology qualification claim.

Closing disables actions immediately and drains pending capture/settle work before destroying the borrowed view and storage owner. Reopen receives focus and recovers saved text with an empty history store. The exported `dispose()` closes both instances and retires page-level reopen listeners; a failed flush keeps the page recoverable. This is distinct from closing just one instance so it can be reopened. Retained restore callbacks remain fenced by the retired public restorer adapter.

Internal integrated walkthrough (local browser slice):

1. Launch the opt-in page with the command above. In Task, type a short plain-text baseline, save locally and capture it with a name.
2. Replace the live wording, save and capture the draft. Select baseline/draft in Before/After and compare. Inspection and comparison preserve the live draft and journal.
3. Inspect the baseline, preview its supported text restoration and confirm. Undo returns to the draft; redo restores the baseline as one ordinary local edit. Source and node identities remain unchanged.
4. Preview again, edit the live wording, then confirm the old preview: the stale conflict retains the newer wording and base/current/proposed recovery. Turning readonly on retires any pending confirmation. Return to writable and create a fresh preview explicitly.
5. Save locally, close and reload. The saved text reopens; captures are empty. The independent Comment remains available throughout. This walkthrough does not exercise the still-unresolved failed-write retry or authorize discarding unsaved recovery.

The eighth focused group is `node tests/scenarios/revision-review-product.mjs integrated`; the lifecycle groups are `reopen` and `keyboard`. All run on Chromium/Firefox/WebKit. A final delivery is accepted only by:

```sh
node scripts/check-revision-review-product.mjs /absolute/path/to/delivery.json /absolute/path/to/actual-main/core /absolute/path/to/guard-result.json
```

The guard requires the actual local main commit and working bytes, qualified owner source/archive/WASM pins, every original case in all eight groups, complete teardown, unchanged affected code/runtime for evidence-only reuse, a locked main landing receipt and a handoff artifact. A passing subset or an incomplete delivery returns nonzero. Guard mutation checks run with `node --test tests/scenarios/revision-review-delivery-guard.mjs`; these are deterministic evidence-validator checks, not product/browser passes. Complete local handoff remains pending until the original save-retry/reopen predicate passes on a qualified PRIMARY owner repair. Whole-editor alpha, native/OS/AT, cloud, performance, exhaustive matrices, public docs and release qualification remain with their existing owners.
