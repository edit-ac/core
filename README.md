# edit.ac core

<p align="center"><img src="brand/editac-github-avatar.png" alt="edit.ac logo" width="120"></p>

[Editor identity and artwork](brand/README.md)

Rust engine and web SDK workspace for edit.ac, an embeddable collaborative editor.

The private browser SDK implements document editing, Markdown clipboard input,
local recovery and host-supplied synchronization over one Rust/Yrs replica. React
and Astro provide optional lifecycle bindings. Packages remain unpublished;
release performance and actual-device qualification are separate work.

## Getting started

Follow [integration and recovery](docs/integration.md) for runnable
[plain browser and React examples](examples/task-editor/README.md) or the
[Astro static/SSR example](examples/astro/README.md), qualified against local
packed artifacts. The guide explains supported formats, asset hosting, save
statuses, host authentication/uploads and cleanup. Native UI and device input
parity are not established.

## Workspace

| Path | Responsibility |
| --- | --- |
| `crates/editac-core` | Rust document semantics over Yrs |
| `crates/editac-wasm` | Browser binding boundary |
| `packages/core` | Shared async WASM runtime |
| `packages/web` | Imperative browser surface, persistence and sync |
| `packages/react` | Optional React lifecycle bindings |
| `packages/astro` | Optional Astro host and client bridge |

## Development

For repeatable local regression checks, watch-mode performance measurements and
CI benchmark reports, see [the development benchmark guide](benchmarks/README.md).

The toolchain baseline is Rust 1.97.1, Node.js 24.19.0, and npm 11.17.0. The npm
workspace pins TypeScript 7.0.2, Yjs 13.6.33 and y-protocols 1.0.7 for development;
the optional framework bindings depend on the shared SDK. Yjs is fixture-only.

Rust pins Yrs 0.28.0 with `small-client` (32-bit client IDs for Yjs 13) and
wasm-bindgen 0.2.129 with its default features. Yrs has no default features;
`sync` and `weak` are not enabled. `editac_core::new_document()` explicitly sets UTF-16 offsets. Rust 1.97.1
is the required, checked compiler baseline, not a claim of compatibility with
older compilers. `rust-toolchain.toml` includes the `wasm32-unknown-unknown` target.
Binding generation uses the matching wasm-bindgen CLI 0.2.129.

```sh
cargo fetch --locked
npm ci --ignore-scripts
npm run check
```

`npm run check` checks Rust formatting, compiles and tests the Rust workspace,
typechecks and builds every npm workspace, then imports each compiled package.
It also checks the WASM target and runs the deterministic protocol, fixture and
interop checks, including the frozen JS schema and bidirectional structural
exchange. Rust validation runs offline after fetching the locked dependencies.
Named suites qualify implemented editor and storage contracts; the full actual-device
and native support matrix remains unqualified.
CI additionally installs the pinned binding generator and headless Chromium,
then runs `npm run check:wasm` against compiled and packed assets.

For Rust-only development:

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked --offline
cargo test --workspace --locked --offline
cargo check -p editac-wasm --target wasm32-unknown-unknown --locked --offline
```

Build output lives in `target/` and `packages/*/dist/` and is ignored by Git. npm
exports point to `dist/`, so run the build before importing workspace packages.
`npm run build` compiles TypeScript; `npm run build:wasm` builds the actual
WASM binary, web-target glue and core wrapper. Install the exact CLI and browser
toolchain as described in [the core package](packages/core/README.md), then run
`npm run check:wasm` for supplied-URL, installed-tarball and SSR checks.
The package remains private and unpublishable.

## Distribution

The public GitHub repository uses Apache-2.0. All Cargo packages have
`publish = false`, and all npm packages have `private: true` until implementation,
API review, package-content checks, and release gates pass. npm manifests do not
reserve names in the registry. Public npm packages will use the `@edit-ac` scope.

Future native adapters reuse the Rust model; this checkout provides no native UI,
Swift/Kotlin bindings, or promise of native parity.
