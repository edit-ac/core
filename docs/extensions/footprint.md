# Extension loading and footprint

The public library shares the qualified engine. Data-defined descriptors import
`ModuleRegistry` from `@edit-ac/core/extensions`; browser factories import from
`@edit-ac/web/modules`, and math rendering imports from `@edit-ac/web/math`.
A missing presenter retains stored content through its source fallback. A future
version stays opaque and recoverable. Neither registration nor importing these
entry points authorizes a host lookup, asset fetch or schema migration.

The executable consumers in `fixtures/extensions/consumers/` use packed public
packages. `minimal.mjs` retains the full Task lifecycle and portable registry,
with all optional presenters disabled. `enabled.mjs` adds slash, references,
reorder, content (images/tables), and math. Math's local renderer/KaTeX chunk is
loaded only when its explicitly enabled presenter mounts valid stored content.
The renderer uses MathML; it contributes no CSS fonts or image assets. Host image
policy and reference lookup remain explicit. The conformance browser serves only
measured production resources and prepared fixture checkpoints over loopback.

Run from the core repository:

```sh
npm run build
npm run typecheck
EDITAC_EXTENSION_BUNDLES_OUTPUT=/absolute/evidence/directory \
  node --test tests/extension-bundles.test.mjs
```

The named suite uses the shared `scripts/check-browser-size.mjs` and
`browser-size-contract.mjs` for the default Task profile. It packs current
`@edit-ac/core`/`@edit-ac/web` artifacts, bundles public consumers with esbuild
0.25.12 for ES2022 and Terser 5.44.0 (module compression, three passes, lexical
mangling; no unsafe transforms), and inventories every static/lazy output.
Gzip level 9 with fixed metadata is admission; Brotli quality 11 is diagnostic.
Every distinct delivered resource counts once, including generated WASM glue,
required lazy JavaScript, the semantic engine and essential Task CSS.

Default Task admission is independent of the extension consumers: **524,288 total
and 32,768 editor JS gzip bytes**. Preferred targets are **256,000 total and 16,000
JS bytes**. Both caps must pass; preferred misses remain visible. The default
keeps rich-text, collaboration, persistence, clipboard and link capabilities.
Markdown is optional under the existing approved profile contract, with static
and actual runtime absence checked by the shared harness. Enabled extension
measurements are informational and cannot qualify a smaller default by changing
its feature semantics. `profiles.json` reports raw/gzip/Brotli sizes, hashes,
settings, package identities, enabled-minus-minimal and each profile's delta from
the independent default. `default-task/manifest.json` contains both cap and
preferred results. No native binary-size savings follow from these browser bytes.

The canonical suite exercises the measured default's editing, direct sync,
clipboard and recovery in Chromium, Firefox and WebKit. Each extension consumer
also mounts the real editor with IndexedDB over 12 qualified custom/built-in,
disabled and unknown-version checkpoint cells. An unrelated committed edit,
flush, disposal and reopen preserve the original extension payload. Actual request
traces prove minimal absence, import-time absence of engine requests, math's
lazy activation, and no implicit image/reference/provider fetch. Enabled factories
are real implementations; these loading checks do not qualify all their editing
interactions or native parity.

`native-terminal-inventory.json` records actual offline Cargo metadata and hashed
manifest sources, plus Android control-probe dependencies. Portable built-ins are
compiled into `editac-core`, without per-module optional Cargo features. FFI's
`bindgen` feature is tooling. The terminal checkout is currently a dependency-free
scaffold. Swift/Kotlin/desktop/TUI richer renderers and their asset/binary receipts
remain owned by downstream tracks. An empty renderer-asset inventory means no
implemented renderer assets in these manifests, not measured size savings or
platform readiness. Publication is outside this proof.

Current pinned measurements and exact executed/passed/failed/skipped counts are
in `architecture/evidence/extension-bundles.md` and its receipt. Failed attempts
remain in the evidence directory and never establish acceptance.

## Qualified measurement

At the EXT-1.9 pinned receipt (2026-10-14 UTC):

| Profile | Total gzip bytes | Editor JS gzip bytes | Default cap admission |
| --- | ---: | ---: | --- |
| Default Task | 485,669 | 32,248 | Both pass; both preferred targets missed |
| Minimal extension consumer (Task + registry) | 486,994 | 33,573 | Informational; JS exceeds default cap by 805 |
| All enabled extension presenters | 573,194 | 119,773 | Informational; both default caps exceeded |

The all-enabled increment over the minimal extension consumer is 86,200 gzip
bytes. The minimal registry increment over default Task is 1,325 gzip bytes.
These totals include the identical shared engine WASM and essential CSS. The
minimal extension consumer adds explicit registry APIs; it does not substitute
for the independently qualified default Task preset. No extension-enabled cap
exception or change to the default's capabilities is implied.
