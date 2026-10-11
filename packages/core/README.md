# @edit-ac/core

Private foundation fixture loading boundary. This is a disposable XML/text
interop bridge, not the frozen structural schema or an editor API.

Use the pinned Rust 1.97.1 toolchain and wasm32-unknown-unknown target. Install
`cargo install wasm-bindgen-cli --version 0.2.129 --locked`, then run
`npm ci` and `npm run build:wasm` from the repository root. `WASM_BINDGEN` may
point to an exact-version CLI binary; the build rejects other versions. Cargo
builds with the lockfile in offline mode, so fetch locked dependencies first
when preparing a new machine. Generated web-target bindings live only in
`dist/wasm/`; they never overwrite this package's metadata or source.

```js
import { init } from '@edit-ac/core';

const runtime = await init('/assets/editac_wasm_bg.wasm');
const fixture = runtime.createFixture();
try {
  console.log(fixture.text(), fixture.utf16_length());
  const bytes = fixture.update_v1(); // receipt of bytes is not durable storage
} finally {
  fixture.free();
}
```

The host supplies a nonempty asset URL and serves WASM as `application/wasm`.
The package export `@edit-ac/core/wasm` identifies the packed binary for a host's
asset pipeline; browsers cannot import that binary directly as JavaScript.
The tested loading mode is native browser ESM. Serve `dist/index.js` with its
relative `dist/wasm/editac_wasm.js` dependency, or copy the whole `dist` tree.
Bundler-specific asset rewriting is not qualified here.

SSR import performs no fetch, browser-global access, instantiation or document
creation. Only `init(assetUrl)` loads the runtime, and only `createFixture()`
creates a Yrs replica. Concurrent calls with the same URL share initialization;
a different URL is rejected after loading starts. A failed load rejects and
allows retry. `createdDocumentCount()` is a cumulative fixture diagnostic.

`apply_v1(bytes)` accepts trusted fixture updates and decodes before mutation.
It is not an untrusted-update admission port. The bridge uses the core UTF-16
factory, Yrs 0.28.0 with small-client, v1 updates and the earlier `interop` XML
root. Production schema commands, resource limits and persistence are later work.

For the actual browser and installed-tarball smoke checks, run
`npx playwright install chromium --only-shell`, then `npm run check:wasm`.
Playwright is pinned in the workspace lockfile. The harness installs a local
tarball offline into a temporary consumer and shuts down its server/browser.

Publishing is disabled until the implementation and release gates in
[edit-ac/architecture](https://github.com/edit-ac/architecture) pass.
License: Apache-2.0.
