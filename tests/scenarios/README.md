# Browser product scenarios

From the core repository, select Node 24.19.0/npm 11.17.0 and put the Rust
1.97.1 toolchain and wasm-bindgen 0.2.129 on PATH, then run:

```sh
node tests/scenarios/run.mjs web-bootstrap
```

The dispatcher reads `fixtures/product-scenarios/web/manifest.json`. Unknown IDs,
absent commands/fixtures and empty case lists fail before launch. Only implemented
scenario IDs are accepted. Later browser workflows are separate roadmap gates.

The bootstrap builds the committed SDK revision in an isolated source snapshot,
installs local tarballs offline, and serves the existing task example with the
existing fixture server. Chromium uses real WASM, Session and IndexedDB. Prepared
fixture inputs grant local editing only; no cloud, provider or credentials are
used. Builds use the committed Cargo files, preserving unrelated dirty changes.

To reuse an existing immutable SDK build, set `EDITAC_PRODUCT_PACK_RECEIPT` to its
`receipt.json`. The harness verifies the exact committed revision/tree and every
tarball hash, then performs a fresh offline consumer install and browser run.
Browser results from a failed receipt are never reused.

Each invocation creates a timestamped directory under
`../architecture/evidence/browser-product-workflows-20261018/pwe-1.1/`.
`manifest.json` resolves the source revision/tree, sample hashes, package hashes,
browser version and served artifact hashes. `receipt.json` records commands,
counts, requests, process ownership and teardown. Logs and screenshots are separate
files. A setup failure or fewer executed cases than required is an unsuccessful
run even if individual cases passed. Browser and fixture server close in teardown;
no preview is intentionally retained.

These are browser bootstrap receipts. They do not establish the original
all-platform capability matrix, later two-editor/React/recovery outcomes, or release
qualification. Reuse an existing receipt only when its owning source and exact
artifact hashes still match.

Local save/offline/recovery workflow: `node tests/scenarios/run.mjs web-local-recovery`.
This runs the actual installed SDK/WASM and IndexedDB with prepared browser API
failures. It includes an explicitly cached offline shell, real offline reload and
per-document commits/reopen, pending/error status, permission revocation, failed
append retention, deliberate isolated recovery downloads, initial/open denial and
missing/corrupt checkpoint handling. Receipts and screenshots are under PWE-1.4.
No remote service, credentials or paid provider is involved.
