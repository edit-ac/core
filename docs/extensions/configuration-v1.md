# Configure an editor with existing extension ports

`createEditor`, `mountEditor`, and `mountEditorSurface` accept `extensions`,
`formatting`, `platform`, `collaboration`, and `assets`. Configuration is admitted
before a root is reserved or recovery starts. `extensions: []` selects local
editing without a provider. Shipped factories include `DocumentSearch`,
`BlockReorder`, `Images`, `Tables`, `MathNotation`, `References`, `SlashCommands`, and `Markdown`. Their codecs, presenters,
commands, cleanup and history remain the existing implementations. Factories
return separate frozen values. Unknown or modified adapters fail before
attachment. Custom authoring belongs to EXT-1.15; production bundle/hosting
qualification remains open. The catalog entries for Code and Pairs are still
contract fixtures and are not advertised as qualified facade factories.

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
input adapters are attached before `ready`. `Markdown.configure()` waits for the
qualified codec and installs its existing typing and paste adapter. Install the
optional `@edit-ac/markdown` package alongside `@edit-ac/web`; a direct browser
host maps `@edit-ac/markdown/web` to that package's `dist/web.js`. Its default WASM
URL is relative to that entry. `assets.manifest.markdown` or `assets.baseURL`
provides the single explicit override. The module import initializes no codec
until selected. Independent bundle/hosting/browser qualification is SDK-1.12.

`Markdown.configure({ input: false })` is command-lazy: ordinary input remains
literal and ready while `editor.exportMarkdown(blocks)` loads the exporter on
its first explicit call. This method snapshots the supplied blocks before its
asynchronous boundary. It returns the existing codec's diagnostics and recovery
blocks without mutating the editor. The borrowed surface exposes the same method.
Per-feature status reports idle/loading/ready/failed/cancelled and a generation;
`loadExtension('editac.markdown')` explicitly retries a failed codec. A failed
required adapter rejects the original `ready` promise and keeps canonical source
read-only. Await `loadExtension` to resume that same replica after repair. Failed
module resolution may require installing the optional package and remounting;
an asset failure can be retried in place. Disposal cancels each attachment even
when compatible immutable module initialization continues for another consumer.

`Images` and `Tables` load the existing source-preserving content presenters on
activation. Without a host image asset service, Images shows its retained source
and unavailable state and does not fetch a document URL automatically. Table
edits use the existing prepared commands and shared undo. A factory never
implicitly selects another family.

Borrowed `mountEditorSurface` leaves engine and persistence disposal to its host.
For managed collaboration on that path, recover the existing owner once with
`openEditorStorage(localRecoveryOptions)` and pass its engine and `storageOwner`:

```ts
import { openEditorStorage, mountEditorSurface } from '@edit-ac/web';
const owner = await openEditorStorage(localRecoveryOptions);
const surface = mountEditorSurface(root, owner.engine, {
  extensions: [], storageOwner: owner,
  collaboration: { connect: hostConnector },
});
await surface.ready;
// Keep the same owner across view remounts. Destroy it only when the host closes it.
surface.dispose();
await owner.destroy({ policy: 'flush' });
```

This bridge delegates to the same local storage, durable outbox, SyncSession and
presence implementations as `createEditor`. The owner must belong to the exact
engine; conflicting commit ports fail before attachment. A borrowed view without
that owner retains its existing explicit host commit/sync path and rejects managed
collaboration. Disposing a view cancels connector/attachment work without destroying
the host's history or recoverable unsent edits.

`MathNotation.configure()` admits the existing math atom definition and uses its
qualified source-preserving preview; it introduces no new engine semantics.
`References.configure({ host, triggers })` accepts the existing versioned reference
host or legacy resolver. `SlashCommands.configure({ commands, literal })` captures
existing prepared command callbacks and bounded metadata once. Neither resolves references nor prepares slash actions on configuration or startup. Keep these original immutable configured
values: copying or serializing them drops their intentionally non-document host
bindings and is rejected before attachment. Reusing a value creates independent
presenters, requests and cancellation for each editor. Resolver permissions and
command preparation still go through their existing owners; callbacks receive no
new writable model. Selecting Images/Tables also configures their existing
Markdown codec options when Markdown is selected.

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
