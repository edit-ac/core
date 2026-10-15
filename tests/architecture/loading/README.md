# Packed consumer and optional-loading fitness

Run with Node 24.19.0 and the checked-in Rust toolchain:

```sh
EDITAC_ARCHITECTURE_OUTPUT=/absolute/worktree-owned/output node scripts/check-architecture.mjs --suite consumers-loading
```

The suite builds current production engine/parser WASM and SDK packages. The
SDK-1.8 `check-browser-size.mjs` harness packs and installs public 0.0.0 tarballs
in isolated temporary directories, bundles the actual Task entry and inventories
required lazy glue, runtime, WASM and CSS. Its shared `browser-size-contract.mjs`
alone defines compression, distinct-resource counting, hard caps and preferred
sizes. FIT recomputes those measurements against preserved bytes and verifies
graph inputs against the exact archived packages. No workspace aliases or
unreviewed optional packages enter the minimal graph. Missing output imports,
resources, input hashes, or measurements reject admission.

Default and enabled Markdown profiles use identical base tarballs. Both record
gzip/raw/Brotli bytes, compressor/minifier identities, source hashes and
preferred-size results; enabled combined and incremental costs remain separate.
Only the default Task profile is admitted against the independent 524288 total
and 32768 JS gzip caps. Decimal preferred limits remain 256000/16000 bytes.
An optional profile cannot qualify the default profile or relax its caps.

The exact measured minified default/enabled artifacts execute editing, atomic
rejection, history, peer transport and IndexedDB recovery on Chromium, Firefox
and WebKit. Independent installed ESM/React/Astro static/SSR consumers check
public declarations, assets, navigation, CSP, ownership and disposal. The public
portable FFI consumer checks seven real ABI behaviors. Locked Cargo feature and
actual JS source graphs reuse FIT-1.1 ownership checks. These are deterministic
local integrations, with no provider calls or native platform SDK claim.

Compatibility scope is the implemented unpublished 0.0.0 package identity and
its exported public contracts. Exact previous/current schema/API/ABI upgrade
policy remains owned by FIT-1.5; this suite promises no arbitrary semver range.
Optional native renderers, highlighters, converters and cloud providers remain
pending at their owning tracks; absent implementations have no invented enabled
cost. Disabled graph negatives ensure these packages cannot silently leak in.

The canonical receipt records outer counts and hashes. The linked
`consumers-loading-inventory.json` records nested test counts, exact commands,
source pins, package hashes and every preserved artifact/log hash. Failures and
skips fail qualification. Existing harness teardown closes its browsers/servers
and removes isolated consumers even on failure; preserved artifacts are evidence.

The amended FIT-1.6-I2 gate requires `EDITAC_SHARED_RESOURCES_RECEIPT` to name
SDK-1.10's retained `shared-receipt.json` directory. The canonical command rejects
missing/incomplete/stale SHR-01–08 evidence; historical single-consumer passes
retain their earlier scope. `scripts/shared-resource-contract.mjs` checks the
required matrix, exact current source and retained evidence identities, duplicate
asset bytes/URLs, compatible generated owners and disabled-only optional absence.
Default gzip results must match the canonical shared counting harness.

Same-page preparation uses the existing installed-package browser harness:

```sh
node --test tests/wasm-runtime-loader.test.mjs tests/shared-editor-resources.test.mjs
EDITAC_SHARED_RESOURCES_OUTPUT=<retained-output> npm run test:browser -- shared-resources
node scripts/collect-shared-resources.mjs <retained-output>
```

The collector writes `same-page-receipt.json` with `complete:false` and every
missing SHR case. It cannot be supplied as a consolidated receipt. These actual
browser cases exercise real production core/Markdown WASM, IndexedDB recovery,
flush/report, history and permission isolation, deferred/disposed recovery,
shared failures/retries, bounded repeated mounts and optional math lifetimes.
Fetch/instantiation counters are separate from issued/released sessions and
actual generated `Engine.restore`/`free` observations; the observer delegates
to the unchanged packed implementation and counts post-reload handles only;
seed creation occurs before a fresh realm used for each sharing observation.
The MathML renderer installs no CSS/fonts: static style count is zero rather than
an invented stylesheet ref-count test. Browser input is deterministic and does
not qualify OS clipboard, assistive technology or universal performance.

Pending SDK-1.10 continuation extends `tests/packed-consumers.test.mjs` and its
existing plain/React/Astro builders, rather than adding another framework harness:
produce a common split graph and stable versioned asset manifest, both route
navigation modes, cold/cache-disabled/controlled-warm server/browser evidence,
rollover/conflicting build controls and duplicate/eager detector injections.
Retain the common gzip inventory, preferred results, union/incremental costs,
first-visible/edit and per-instance resources. Same-page loader success does not
stand in for that production-build/cache matrix.
