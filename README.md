# edit.ac core

Rust engine and web SDK workspace for edit.ac, an embeddable collaborative editor.

This repository is development scaffolding. It does not yet edit, synchronize,
persist, render, import, or export documents. No package is ready to publish.
The approved development plan and acceptance gates live in
[edit-ac/architecture](https://github.com/edit-ac/architecture).

## Workspace

| Path | Responsibility | Current state |
| --- | --- | --- |
| `crates/editac-core` | Platform-independent document semantics | UTF-16 boundary offset type only |
| `crates/editac-wasm` | Future Rust/browser binding boundary | Empty binding crate |
| `packages/core` | Future `@edit-ac/core` WASM loader and transport | Empty TypeScript module |
| `packages/web` | Future `@edit-ac/web` browser input and DOM adapter | Empty TypeScript module |
| `packages/react` | Future `@edit-ac/react` React host wrapper | Empty TypeScript module |

Rust will own the authoritative semantic document over Yrs. Browser DOM and future
native text views will be projections. The WASM crate must remain independent of
DOM editing, and the React wrapper must not own document state. The roadmap gates
the structural schema, protocol profile, binding API, and native ABI before they
become compatibility promises. No Yrs, Yjs, React, or binding dependency is added
until its owning implementation milestone.

## Development

The toolchain baseline is Rust 1.97.1, Node.js 24.19.0, and npm 11.17.0. The npm
workspace pins TypeScript 7.0.2 for development; it has no runtime dependencies.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` checks Rust formatting, compiles and tests the Rust workspace,
typechecks and builds every npm workspace, then imports each compiled package.
Rust dependencies are currently local only, so Rust validation runs offline.
The initial crate has no editor tests; a green scaffold build is not evidence of
editor correctness or browser/native support.

For Rust-only development:

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked --offline
cargo test --workspace --locked --offline
```

Build output lives in `target/` and `packages/*/dist/` and is ignored by Git. npm
exports point to `dist/`, so run the build before importing workspace packages.
The build currently compiles TypeScript only; it does not produce a WASM bundle.

## Distribution

The public GitHub repository uses Apache-2.0. All Cargo packages have
`publish = false`, and all npm packages have `private: true` until implementation,
API review, package-content checks, and release gates pass. npm manifests do not
reserve names in the registry. Public npm packages will use the `@edit-ac` scope.

Future native adapters reuse the Rust model; this scaffold provides no native UI,
Swift/Kotlin bindings, or promise of native parity.
