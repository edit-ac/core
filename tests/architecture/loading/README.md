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
