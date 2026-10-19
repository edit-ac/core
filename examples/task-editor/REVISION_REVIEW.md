# Local revision review

This opt-in page uses the installed public core/WASM and web packages. Existing task editor routes do not enable it.

Use Node from `.node-version` (24.19.0), then from `core` run:

```sh
node examples/task-editor/revision-review-product.mjs
```

The launcher prepares an offline installed consumer and prints its local URL and PID. Ctrl+C stops the server. `EDITAC_PRODUCT_PACK_RECEIPT=/absolute/path/to/receipt.json` may reuse byte-authenticated core/web tarballs when the harness verifies unchanged committed SDK inputs; it does not reuse browser outcomes.

The task and comment open simultaneously with distinct local identities, databases and bounded memory stores. Each has its own readonly toggle, capture/inspection controls, and close/reopen controls. Closing flushes and disposes only that instance. Reopening recovers its saved document with a fresh empty capture store; the sibling remains usable. Foreign handles are unavailable, and foreign identity/module access is incompatible. No restoration capability is installed here.

Edit either live document, save locally to confirm the journal flush, enter a name, and choose **Capture current state**. **Inspect** shows the existing public historical presenter, with immutable semantic content/hash and unknown provenance. Inspection leaves the live editor alone. Captures are explicit, decrypted memory: 3 retained captures, 24 KiB total and 12 KiB per capture including metadata. FIFO eviction removes older captures; an oversized capture is rejected without eviction. No capture is made while typing. Reload loses captures but reopens saved live content from local IndexedDB. This does not provide durable archival history, original source spelling, authentication, or global causal order.

Focused deterministic browser checks:

```sh
node tests/scenarios/revision-review-product.mjs capture
node tests/scenarios/revision-review-product.mjs scope
```

This executes Chromium, Firefox and WebKit against one pinned installed site, with independent public-engine and raw readonly IndexedDB observations. Receipts, screenshots, package/fixture/WASM hashes and full logs are written under `../architecture/evidence/revision-review-product-20261019/rvp-1.1/`. Scope evidence is under `rvp-1.3/`. Comparison awaits a public captured-snapshot diff operation; prepareReview only validates supplied models. Restoration remains a later gate.
