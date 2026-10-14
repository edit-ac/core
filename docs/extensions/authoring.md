# Write a portable mark and atom

The executable example in `examples/extensions/` registers `demo.highlight` (a
mark) and `demo.badge` (an inline atom) through `@edit-ac/core/extensions`.
Both use bounded text and data attributes already admitted by the engine. The
example includes future-version and unknown data to demonstrate fallback.
These are private development artifacts; no publication, account or service is
needed. Use the pinned Node 24.19.0/npm 11.17.0 and a prepared core checkout with
built packages and qualified production WASM.

From the core checkout, create an empty standalone consumer:

```sh
node scripts/prepare-extension-tutorial.mjs /tmp/my-extension-tutorial
```

The destination must be empty. The command packs the three existing libraries,
extracts them into a private consumer, copies fixed examples/fixtures and bundles
browser entries against the tarballs. It performs no Rust/WASM/native build or
workspace aliasing. Package/input/artifact hashes are recorded in
`qualification/consumer.json`. The imported checkpoint is the qualified native
Rust registration fixture, not another editing model or a fixture-enabled engine.

From the generated consumer directory, run:

```sh
node --test --test-reporter=tap conformance.mjs
```

This executes all 44 shared descriptor cells and four tutorial checks through
public imports and unchanged production WASM. Missing fixtures, failed cases and
skips do not qualify support. From that same directory, start the browser example:

```sh
node serve.mjs --port=0
```

Open the printed loopback URL. **Toggle presenters** remounts the same persisted
document with optional rendering enabled/disabled. **Insert note elsewhere** uses
the admitted Markdown hook and shared atomic command boundary, retaining custom
and unknown runs. **Toggle read-only** makes that action unavailable through the
host's capabilities. Stop the server with Ctrl-C. Before discarding a live replica,
run `await window.tutorial().dispose()`. Flush failure must retain the replica and
be reported, rather than becoming a save acknowledgment or database deletion.

## Register data before attachment

`definitions.json` contains namespace/type, positive u32 stored version, kind,
bounded attributes/content and text fallback. `registerTutorial` validates and
freezes them before the editor attaches. Invalid, duplicate and incompatible
registrations reject before insertion. Registration does not rewrite a document.
Unknown types/versions remain opaque. The public API version is independent of
each descriptor's stored-data version.

Use only `@edit-ac/core`, `@edit-ac/core/extensions`, `@edit-ac/web`,
`@edit-ac/web/modules` and optional `@edit-ac/markdown`. Private source/dist imports
and fixture-only engine exports are unsupported. Conformance resolves WASM via
public package exports; the browser consumes copies of those exact artifacts.

## Keep optional presenters outside document state

The host supplies synchronous mount/update/dispose hooks to `ModuleRuntime`.
They use `textContent` and accessible labels; HTML-looking source stays inert.
The renderer owns its decoration, while the editor owns canonical text,
selection, input, composition and the engine replica. The admitted atom wrapper
is noneditable only with its presenter enabled. Absent presenters show text
fallback. Functions, credentials, executable code and implicit asset-fetch
authority never enter document state.

The example allocates no worker, network or timer. Its disposer is idempotent.
`openTutorial().dispose()` cancels commands, releases its subscription, and awaits
the owning editor's flush/destruction; the runtime releases views. Trusted hook
exceptions do not confer mutation authority. An in-process infinite loop cannot
be preempted by try/catch; only trusted bounded hooks belong here.

## Reuse codec, capability and command boundaries

`prepareNote` uses the owning Markdown codec and `prepareExtensionSource` with a
pure `[note] ` hook, mapping to existing heading/bold semantics with checked
lossless serialization. Literal input bypasses the hook. This does not create an
arbitrary-module-attribute codec. `insertNote` prepares an atomic fragment at
stable UTF-16 anchors and invokes `ExtensionCommandSession` through the actual
editor's revision, `can` and `commit` ports. Capability/revision/cancellation are
rechecked before commit. Anchors and returned caret/selection handles are released
on all outcomes. Engine admission, history and IndexedDB journaling stay with the
owning editor; never create a second writable replica for extension UI.

Custom module attributes currently have no admitted lossless Markdown fragment
encoding. `exportFallback` returns readable source, an explicit
`module-markdown-unrepresentable` diagnostic and the original initialized
checkpoint for recovery. The source alone is not a copy of those attributes.
Never replace the original from a flattened string. Source edits elsewhere retain
custom/opaque runs; the canonical tutorial check proves this with actual browser
editor/storage/reopen, including disabled and absent registrations.

## New editing semantics and migrations need owning contracts

Data registration does not create an arbitrary-attribute editing command, schema,
embed, formatter or downloaded plugin runtime. Operations the existing commands
cannot express require qualified core implementation and WASM/native bindings.
This tutorial imports admitted custom content and edits other blocks; it does not
claim arbitrary custom-content insertion or native renderer parity.

Declare compatible reads and directed migrations via `prepareModuleMigration`.
The candidate is inert data, not an engine edit; the host separately admits a
supported edit or explicit new-epoch migration. Never migrate during registration
or reinterpret delayed offline updates. Hosts own authorization, persistence,
transport, asset access and platform capabilities. Browser/terminal/Swift/Kotlin/
desktop renderer and actual-device parity remain downstream capability obligations.
