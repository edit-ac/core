# Dependency-layer fitness

Run with the checked-in Node and Rust toolchains:

```sh
node scripts/check-architecture.mjs --suite layers
```

`contracts/layers.json` owns every current Cargo/JavaScript workspace member and
its permitted direct dependencies. Changes to that manifest are architecture
decisions: adding a dependency to a package alone does not authorize it. The
minimum Rust closure has a reviewed external-crate inventory, so new transitive
runtime or build dependencies fail even when the direct dependency is unchanged.
Exact versions and sources are reported from the locked metadata and hashed lock.
The engine's `url` crate parses identifiers; it is not an HTTP client. Yrs and its
deterministic primitives remain engine dependencies. No UI, HTTP client, cloud,
conversion or highlighting runtime is admitted to the engine/minimum SDK.

The existing session, diff and Markdown crates are explicit portable companions.
The optional Markdown WASM bridge belongs to that companion, not the minimum
engine bridge. The JavaScript Markdown package's existing web adapter explains
its declared web dependency. React/Astro peer dependencies belong only to their
client adapters. This check does not create a new public package or service.

Cargo metadata is locked/offline. Normal and build edges are checked for every
workspace member, including target predicates in the resolved graph. Disabled
optional declarations must also be owned. Dev-only edges are reported separately;
in particular the engine's Markdown test fixture is not a production dependency.
The minimum closure is conservative across resolved target predicates, not a
measurement of a compiled target's size. There is no advisory/network lookup.

The JS adapter checks runtime/optional/peer declarations and source imports,
exports, type imports, dynamic imports and CommonJS requires with the locked
Babel TypeScript parser. Astro frontmatter and inline scripts are included. Missing,
computed and private cross-package relative imports fail closed. The production
and foundation-fixture generated WASM import sites map to their Cargo producers;
their generated artifact bytes and packed/lazy loading remain FIT-1.6's proof.
The existing math asset builder's KaTeX source is recorded as an optional web
runtime dependency even though its npm declaration is a build devDependency.
Its installed version, pinned source hash and absence of further imports are
checked; this exception cannot make a build dependency available to other owners.
This suite checks source ownership, not every package version or platform runtime.

The dispatcher reads suite registrations from the manifest. Unknown suites,
missing files, zero tests, failures, cancellations, skips and TODOs fail. Every
invocation saves TAP, a revision/hash receipt and (on graph success) the full
source graph under an isolated `architecture-results` directory. Set an absolute
`EDITAC_ARCHITECTURE_OUTPUT` to choose the evidence directory. Deterministic
negative fixtures exercise direct, transitive, aliased and disabled violations;
the final test examines the actual repository rather than just those fixtures.
