# Configure an editor with existing extension ports

`createEditor`, `mountEditor`, and `mountEditorSurface` accept `extensions`,
`formatting`, `platform`, `collaboration`, and `assets`. Configuration is admitted
before a root is reserved or recovery starts. `extensions: []` selects local
editing without a provider. The initial executable factories are
`DocumentSearch.configure()` and `BlockReorder.configure()`; their presenters,
commands, cleanup and history remain the existing implementations. Factories
return separate frozen values, including their portable options. Unknown or
unimplemented adapters fail before attachment. Custom authoring belongs to
EXT-1.15; optional parser/rendering/converter loaders belong to SDK-1.12.

```ts
import { createEditor, DocumentSearch, BlockReorder } from '@edit-ac/web';

const editor = createEditor(root, {
  ...localRecoveryOptions,
  extensions: [DocumentSearch.configure(), BlockReorder.configure()],
  formatting: { marks: { bold: { shortcuts: false, controls: false } } },
  platform: { spellcheck: 'platform', autocorrection: 'inherit' },
});
await editor.ready;
```

`localRecoveryOptions` identifies an existing checkpoint and its IndexedDB,
locking and engine asset ports. Opening never creates or replaces that document.
`extensionConfiguration` exposes the frozen admission result, and
`extensionStatus` reports each selected feature's attachment status. Required
input presenters are attached before `ready`. No command-lazy exporter is
advertised by this implementation. Borrowed `mountEditorSurface` handles expose
the same readiness/status policy and leave persistence and engine disposal to
their host. Managed collaboration requires `createEditor`/`mountEditor`, whose
storage owner already supplies the durable outbox. Borrowed surfaces reject
managed collaboration before attachment; their existing host-owned sync remains
available.

`defaultPreset()` expands to an empty extension list with the existing Task
editing defaults. `documentPreset()` adds the qualified Search and Reorder
members of the existing document-tools profile. These are inspectable convenience
lists, not new schemas or a promise to install host-resolver tools. Both accept
`extensions`, `remove` (feature IDs), and explicit `overrides`. Duplicate selection
still fails admission; an override must name an already selected feature. A host
can configure any shipped factory without a preset or a product/use-case label.
The legacy `taskPreset()`, `preset: 'task' | 'minimal'`, low-level profile APIs and
assembly ports retain their names and behavior. Mixing a facade call with legacy
assembly keys, even `false`, throws `legacy-conflict`. Migrate the assembly as a
unit. Legacy `inputHints` also conflicts because it couples multiple platform
traits; it remains available on legacy editors.

Formatting uses the existing prepared formatting and keyboard owners for bold,
italic, underline, strike, inline code and links. `commands`, `shortcuts` and
`controls` are separate policies. Disabling a command requires both other fields
to be explicitly false. Hiding SDK controls does not disable a host command or
remove existing marks. Advanced engine/commit ports remain trusted host ports,
not an authorization sandbox. Legacy Task controls keep their existing list;
facade controls can additionally expose the existing strike/inline-code actions.
Task has not been renamed to a smaller feature or byte baseline. Current package
sizes/hashes are retained in the configuration receipt; previous Task inventories
remain historical evidence, and no budget/release qualification is claimed.

Platform mode preserves explicit and inherited spelling attributes. Off mode
requests `spellcheck=false`; autocorrection is independently inherited/on/off.
Locale is an explicit `lang` hint. No policy changes capitalization, prediction,
smart substitutions or keyboard settings. `platformPreferences` separates the
requested policy from `observed: 'unknown'`: HTML attributes do not prove effective
OS/browser settings. Disposal restores only attributes still holding SDK-written
values, preserving later host changes. A custom mode without a checker fails
`missing-checker`, with no fallback or checker download. EXT-1.18 owns the explicit
custom checker recipe, and INT-1.14 owns actual platform observations. A mode
change uses a safe view remount, preserving the borrowed engine and its history.

Collaboration is absent by default. An explicit connector receives an editor-owned
abort signal and generation and returns the existing `AttachSyncOptions`.
Default local readiness never waits for this connector; failure leaves local
editing and recovery available. Explicit `readiness: 'remote'` keeps input and
commands unavailable until an authorized attachment succeeds. Identity and wire
admission stay with the existing sync adapter. `collaborationStatus` distinguishes
loading, ready, failed and cancelled; errors are observable without rejecting local
readiness. `connectCollaboration()` retries/replaces the connection;
`disconnectCollaboration()` aborts pending work and detaches it. Public legacy
`attachSync()` supersedes pending facade work and preserves its legacy unauthorized
handle behavior. Neither detach nor reconnect recreates the replica/history or
deletes unsent durable edits. Late connector completions cannot attach a surface.

Awareness and peer carets are independent explicit options; carets require
awareness. If enabled, the connector must return a separate `presence` transport
and client ID. Returned presence services are ignored when awareness is disabled.
The attachment's optional `presence.receive` routes host-authenticated awareness
frames; `pump(now)` drives sync and awareness with monotonic host time. There is
no SDK socket or background timer. Carets project existing resolved anchors and
own only transient DOM. Detach removes their listeners, anchors and presentation.
One editor's connector/presence never enables a sibling local field.

An advanced `assets` override is one absolute base URL or manifest. The engine
base URL points to the directory containing `editac_wasm_bg.wasm`; a manifest
uses `engine` for that file. It overrides the recovery bootstrap `assetUrl`.
Compatible editors must retain the existing runtime's identical asset URL.
Borrowed engines are already initialized by their host. Optional feature chunks,
broader managed asset discovery, MIME/CSP/CORS qualification and omitted-package
graphs remain SDK-1.12 work. No runtime or optional assets are fetched by importing
the facade on a server.

The executable installed consumer and declaration fixture live in
`tests/extension-dx/configuration-consumer/`. The `configuration` test group uses
real production engine/recovery/history/outbox/wire and awareness ports with local
prepared transports, retaining exact source, package, generated-member and browser
identities. This proves configuration behavior, not provider quality, OS spelling,
performance, native qualification or release readiness.
