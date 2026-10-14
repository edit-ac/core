# Public portable extension library v1

This is an unpublished development library, qualified through local package archives.
API v1 is independent of positive u32 stored descriptor data versions. The exact
source revisions, fixture hashes, packed archives and execution results are in
[the integration receipt](../../../architecture/evidence/extension-library.md).
Publication follows the release policy; these checks establish portable contracts
and examples. Actual renderer, OS clipboard and physical-device support requires
the downstream receipts below.

## Supported imports

| Entry | Contract |
| --- | --- |
| `editac_core::modules::v1` | Existing Rust descriptor/registry/command/evolution contracts |
| `editac_markdown::v1` | Owning Markdown codec contracts |
| `@edit-ac/core/extensions` | `EXTENSION_API_VERSION = 1`, `ModuleRegistry`, `ModuleDefinitionV1`, `ExtensionCommandV1`, `MarkdownCodecV1`, `MarkdownExtensionV1`, candidate evolution, profiles and transfer |
| `@edit-ac/web/modules` | Same portable registry and transfer owner; `ModuleRuntime`, `ExtensionCommandSession`, presenter protocol, source and descriptor conformance, built-in factories and host-controlled references |
| `@edit-ac/web/math` | Explicit optional math presenter; separate loading cost |
| `@edit-ac/core`, `@edit-ac/web`, `@edit-ac/markdown` | Production engine, BrowserEditor/storage/capabilities and Markdown initialization |

Consumers use package exports and extracted archives, with no source imports or
engine rebuild. [Authoring](authoring.md) provides an executable mark/atom example.
Registration validates bounded data and freezes before attachment. Invalid and
duplicate descriptors reject atomically. Data-defined marks/atoms use qualified
primitives; new editing semantics require owning engine work. Host callbacks and
renderer functions remain outside document state.

Commands prepare without mutation, then use the shared current-capability and
atomic commit boundary. Recheck async revision/target state, cancel stale work,
and release returned anchor/selection resources. Disposal cancels command sessions,
subscriptions and presenters; it is idempotent. Reference activation is an explicit
host-authorized catalog lookup, with revocation and stale-result checks. Rendering
performs no implicit lookup, image fetch, permission grant or provider call.

## Compatibility and recovery

Descriptor reads and pure candidate migrations declare supported transitions.
Registration never migrates live state. Document-wide changes use the owning
schema/epoch protocol; unknown versions and delayed offline updates retain recovery.
Transfer v1 validates JSON, resource bounds and supported formatting before the
owning engine admits a prepared edit. Version 2 tables preserve cell marks, links,
code, paragraph styles, alignment, header and admitted span/geometry metadata.
Unknown versions, absent codecs and future atoms use the bounded inert carrier,
retaining exact identity/version/payload/source with explicit fallback. Source is
never executed as code, formulas or markup and cannot trigger asset fetches.

Copy/cut/paste, undo/redo and checkpoint/journal reopen share the owning semantics.
Literal paste bypasses codecs. Markdown cannot encode every rich table or opaque
payload: export returns diagnostics and typed recovery alongside inert escaped
source. Markdown source alone is insufficient for lossless opaque recovery. Store
the original checkpoint or typed fragment. See [the owning specification](../../../architecture/specs/extension-library.md).

## Built-in matrix

[The complete 210-cell matrix](capabilities.md) and
[`capabilities.json`](../../fixtures/extensions/capabilities.json) specify preservation,
view, edit, copy, Markdown, accessibility and rendering for five hosts, with exact
fixture IDs, evidence records, keyboard/focus obligations and delivery gates.

| Module ID | Portable obligation | Actual presenter obligation |
| --- | --- | --- |
| slash | Registered command and one history intent | Accessible menu/focus; remote edits never open it |
| references | Exact identity/label, offline fallback, explicit host authority | Accessible activation; stale/revoked lookup suppression |
| reorder | Identity-preserving semantic move and selection | Editable-host keyboard action and declared pointer control |
| images | Bounded metadata/alt/source, asset policy | Accessible rendering or explicit source fallback |
| tables | Bounded structure, formatting/transfer preservation | Qualified selection/navigation/editing or declared nonediting fallback |
| math | Bounded source, invalid/unknown preservation | Optional qualified renderer or explicit source fallback |

Fallback proves preservation; it does not establish richer view/edit parity.
The matrix validator rejects absent owners, fixture IDs and unsupported receipt
claims. Its retained historical failures remain visible.

## Official profiles and remaining combinations

[Profile v1](profiles.md) exposes `core`, `document-tools` and `code-tools` through
`FIRST_PARTY_PROFILES`, `FIRST_PARTY_FEATURES`, `prepareExtensionProfile` and
`ExtensionProfileActivation`. Complete dependency/version/schema/capability and
precedence admission occurs before activation. Explicit host remaps produce
diagnostics. Disabled features import no implementation and allocate no resources.
Search/code/pairs remain contract fixtures, rejected by production admission;
prepared fixtures qualify FPX-01–03 and FPX-05–08 only.

FPX-04 requires actual table + search + history, code + pairs + IME and link/slash +
replacement combinations. Owners: rich-content roadmap 25 (`RCH-1` feature owners),
desktop interaction roadmap 38, platform SDK roadmaps 16/17/18 and mobile extension
roadmap 41. The exact pending combinations are in
[`profiles/contracts.json`](../../fixtures/extensions/profiles/contracts.json).
Their real feature artifacts and platform receipts are required; portable profile
contract tests cannot qualify them.

## Downstream qualification handoff

| Owner roadmap | Required fixtures/evidence |
| --- | --- |
| `15-tui-client.md` | `CAP-*-terminal-*` cells and terminal presenter protocol; actual TUI keyboard/source/accessibility support |
| `16-ios-sdk.md` | `CAP-*-swift-ios-*`, shared presenter fixtures and native clipboard catalog; actual iOS renderer/OS-host/device evidence |
| `17-android-sdk.md` | `CAP-*-kotlin-android-*`, shared presenter fixtures and native clipboard catalog; actual Android renderer/OS-host/device evidence |
| `18-desktop-native.md` | `CAP-*-desktop-*`, native clipboard/desktop interaction fixtures; actual desktop renderer and OS-host evidence |
| `41-mobile-web-extensions.md` | `CAP-*-browser-*`, mobile extension cases; actual touch/focus/viewport/device presenter proof |
| `10-web-qualification.md` and `37-ecosystem-qualification.md` | Consume exact platform/library artifacts and capability cells; final cross-client qualification |
| roadmap 05 `FMT-1.15-V1` | Physical clipboard/menu/shortcut release proof; emulator-development receipt does not close physical release |

Fixture sources: [presenter corpus](../../fixtures/extensions/presenters/conformance.json),
[native clipboard cases](../../../architecture/tests/native-clipboard-cases.md),
[desktop FPX cases](../../../architecture/tests/desktop-editing-cases.md) and
[mobile extension cases](../../../architecture/tests/mobile-extension-cases.md).
Actual missing renderer/device evidence remains pending in the capability matrix.
No dependency cycle is introduced: this library supplies contracts and fixtures;
downstream owners supply actual implementations and final delivery consumes both.

## Reproduction and artifact costs

Use Node 24.19.0/npm 11.17.0 and the pinned Rust/WASM toolchain. Rebuild lane-local
production WASM/Markdown/packages, then run from `core`:

```sh
EDITAC_EXTENSION_LIBRARY_OUTPUT=/absolute/new/evidence/directory node --test tests/extension-consumers.test.mjs
node --test tests/extension-capabilities.test.mjs
```

The named consumer suite packs core/web/markdown, extracts clean archives, bundles
public imports and runs actual Chromium/Firefox/WebKit BrowserEditor capability,
clipboard, IndexedDB history/reopen, tutorial and lifecycle flows. All ten transfer
cells and 17 profile cases must execute on every browser. Network routes allow only
the task-owned local fixture server. Teardown closes every browser/server and removes
the temporary consumer; archives and manifests remain as evidence.

[Footprint](footprint.md) records optional costs and native/TUI inventory. Latest
merged default Task hard-cap proof is 488,537 total / 32,376 JS gzip bytes against
524,288 / 32,768 caps. Preferred 256,000 / 16,000 targets miss. Historical minimal
and all-enabled costs are versioned measurements, not current default claims.
Generated glue, required lazy code and runtime dependencies count. This handoff
adds documentation/test fixtures without changing the runtime artifact inputs.
