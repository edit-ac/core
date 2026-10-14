# Dependency maintenance inventory

`node scripts/check-dependencies.mjs --write` generates `inventory.json` and a
content-addressed notice store from the exact Cargo/npm locks, offline cached
archives and reviewed artifact manifest in `policy.json`. Review generated changes,
then run `node scripts/check-dependencies.mjs --check` and
`node scripts/check-architecture.mjs --suite dependencies`.

The inventory covers all locked packages, including the all-features Rust native
store and native bridge. Cargo archive SHA256 and npm SHA512 integrity are checked
before extracting notices. Distributed package tarballs must contain notice bytes
matching their source. WASM aggregate notices must include every package/version
and license text in the actual target-filtered dependency closure. A missing
distribution notice, changed archive, omitted optional family or stale inventory
fails the checks. No check installs packages, calls AI providers or reads secrets.

| Update owner | Inputs and release responsibility |
|---|---|
| Core portable/native maintainers | Cargo locks, WASM/native closures, bundled SQLite, UniFFI, RustSec results and distribution notices |
| Browser SDK/build maintainers | npm lock, packed SDK manifests, KaTeX renderer, optional build dependencies and current npm audit |
| Native bridge/session maintainers | Exact portable FFI and optional store artifacts; MPL source and notice obligations |
| Android SDK maintainers | Both Gradle probe locks; exact JAR/POM notices and Maven advisories before an Android release |
| Math/browser maintainers | Renderer and any future font/CSS assets with exact revisions and notices |
| Highlighting maintainers | Any future highlighting runtime and grammar assets |
| Asset/conversion maintainers | Any future media codecs and converter assets |

The current SDKs remain unpublished. Platform records stay pending. The prepared
portable FFI executable is inventoried as a test artifact, not a native SDK.
The optional store's SQLite 3.53.2 amalgamation retains its exact source ID,
source hash and embedded public-domain notice; the binding crate's MIT notice is
separate. The SQLCipher feature is not enabled by this profile.
KaTeX renderer code is bundled with its MIT notice; its fonts/CSS are not copied by
the current build. Grammar and media runtime assets are not distributed. Their
family entries pin implementation inputs and require artifact/notice admission
before addition. Android probe dependencies retain exact locked versions but have
no SDK release qualification or invented license verdict.

Some platform-specific npm archives are uninstalled; some tooling archives omit
notice text. Their lock-declared license and exact integrity remain inventoried,
with explicit unavailable notice state. They are not SDK-bundled components and
cannot pass notice admission if later bundled. Host-supplied React/Astro peers are
also recorded separately from SDK redistribution.

`advisories.json` retains the date, exact input locks, command, current response
digest, findings and source availability. Current npm audit has zero findings.
RustSec checking is unavailable because cargo-audit is absent; Maven checking is
not configured for the probe-only Android project. Both name release actions.
These are unresolved release qualifications, not skipped fitness cases or clean
security scans. Refresh all advisory sources against exact locks before release;
a zero finding result does not certify safety.

UniFFI 0.32.2's MPL-2.0 license is retained from upstream revision
`7bc621ee9d0d15371d792612707ba5ed4111f950`, matching every locked UniFFI crate's
packaged VCS identity. Retain applicable notices and provide corresponding source
under MPL terms when distributing; no upstream source is modified. rsqlite-vfs
0.1.1's missing MIT text is retained from revision
`1bb309784f25c401ddf95131dcde4c4cdad7aee7`, verified against its archive VCS record.
The existing Yrs MIT fallback also retains its pinned upstream identity.
