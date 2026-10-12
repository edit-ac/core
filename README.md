# edit.ac core

<p align="center"><img src="brand/editac-github-avatar.png" alt="edit.ac logo" width="120"></p>

[Editor identity and artwork](brand/README.md)

Rust engine and web SDK workspace for edit.ac, an embeddable collaborative editor.

This repository is development scaffolding. It does not yet edit, synchronize,
persist, render, import, or export documents. No package is ready to publish.
The approved development plan and acceptance gates live in
[edit-ac/architecture](https://github.com/edit-ac/architecture).

## Workspace

| Path | Responsibility | Current state |
| --- | --- | --- |
| `crates/editac-core` | Platform-independent document semantics | UTF-16 offset type and Yrs replica factory |
| `crates/editac-wasm` | Future Rust/browser binding boundary | Compiled disposable XML/text fixture bridge |
| `packages/core` | Future `@edit-ac/core` WASM loader and transport | Explicit async fixture loader; SSR-safe import |
| `packages/web` | Future `@edit-ac/web` browser input and DOM adapter | Empty TypeScript module |
| `packages/react` | Future `@edit-ac/react` React host wrapper | Empty TypeScript module |

Rust will own the authoritative semantic document over Yrs. Browser DOM and future
native text views will be projections. The WASM crate must remain independent of
DOM editing, and the React wrapper must not own document state. The roadmap gates
the structural schema, protocol profile, binding API, and native ABI before they
become compatibility promises. The foundation toolchain now pins Yrs and binding
dependencies. The foundation fixture bridge now exports minimal WASM bindings;
production schema commands remain unimplemented.

## Development

The toolchain baseline is Rust 1.97.1, Node.js 24.19.0, and npm 11.17.0. The npm
workspace pins TypeScript 7.0.2, Yjs 13.6.33 and y-protocols 1.0.7 for development;
the JS packages have no runtime dependencies. Yjs is fixture-only.

Rust pins Yrs 0.28.0 with `small-client` (32-bit client IDs for Yjs 13) and
wasm-bindgen 0.2.129 with its default features. Yrs has no default features;
`sync` and `weak` are not enabled. `editac_core::new_document()` explicitly sets
UTF-16 offsets and leaves root types unset pending the schema gate. Rust 1.97.1
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
These checks qualify the documented foundation fixtures; production editor
behavior, storage and the full browser/native support matrix remain future gates.
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

Future native adapters reuse the Rust model; this scaffold provides no native UI,
Swift/Kotlin bindings, or promise of native parity.
