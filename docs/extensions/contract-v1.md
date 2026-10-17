# Extension configuration contract, version 1

EXT-1.14 freezes pre-attachment data and admission. Public exports are
`EXTENSION_DX_VERSION`, `defineExtensionContract`,
`prepareEditorExtensionConfiguration` and their `*V1` types. These helpers do
not mount an editor, activate callbacks, fetch assets, or change a document.
`createEditor` and `mountEditorSurface` now accept the configuration fields through
their existing lifecycle; see [configuration behavior](configuration-v1.md). `Extension.create`
authoring execution belongs to EXT-1.15. The proposed `Markdown`, `PatternLink`,
`PdfExport` and other factories will implement `ExtensionFactoryV1.configure`;
this contract does not advertise those factories as shipped implementations.

`defineExtensionContract` takes a portable `ProfileFeature`, JSON defaults, a
pure option validator, admitted semantics, a load policy and indexed interests.
Each `configure(partialOptions)` returns an isolated, deeply frozen data value.
Overrides replace a complete option value (nested objects are not deep-merged).
Names and data versions remain stable. Unknown keys and invalid values produce
extension/option/remedy diagnostics. Getters, cycles, functions and non-data
prototypes in portable options are rejected by the existing portable copier.
Host callbacks remain trusted executable host code, outside persisted options.
No sandbox or worker isolation is implied by a TypeScript callback.

`prepareEditorExtensionConfiguration(config, environment)` invokes the existing
`prepareExtensionProfile` once. That owner resolves dependencies, canonical
order, version/schema/capability/permission admission, equal-priority conflicts,
explicit remaps and the frozen data registry. The web facade creates no second
registry implementation, command bus, dispatcher, document or undo manager.
Configuration is complete before surface reservation or asynchronous recovery;
a failure cannot mutate an attached document. Prepared configurations snapshot
options and policies; connector callbacks are retained by identity and never
invoked during admission. Actual authority, identity, stale-generation rejection,
readonly, atomic history and recovery are enforced by the existing editor,
Session and engine at execution time, not granted by admission.

## Selection, migration and presets

The primary selection is an arbitrary `extensions` array with no preset. A
comment, local document or collaborative document can use the same extension.
`default` and `document` are provenance names for inspectable convenience lists
expanded by SDK helpers before this admission call; admission never injects a
hidden extension based on those names. `default` retains lightweight existing
Task editing defaults; `document` can add explicitly configured qualified document
tools. Neither enables collaboration, presence, conversion, spelling dictionaries
or host lookup implicitly. Both allow explicit additions/removals and overrides;
missing required host configuration fails rather than guessing a provider.
Exact executable lists belong to the SDK-1.11 receipt, not this type contract.

Legacy `createEditor`, `taskPreset`, `preset: 'task' | 'minimal'`, low-level module
ports and `core`/`document-tools`/`code-tools` profiles remain unchanged. Task is
not silently renamed to a smaller capability/byte baseline. New `default` maps to
Task editing convenience behavior, while `document` is a convenience expansion
over the existing document-tools profile, not a new schema. A migrated call must
move its assembly options together. Any supplied `legacy` assembly key alongside
facade configuration fails `legacy-conflict`, including false values. Explicit
empty `legacy: {}` is allowed. There is no import-order or last-write precedence.
Legacy aliases remain compatibility exports; no historical budget is reclassified.

## Core policies and local authority

`formatting.marks` offers bold, italic, strike, underline, code and link through
existing core commands. Commands, shortcuts and controls are separate booleans;
omission preserves existing offered behavior. Disabling a command requires both
shortcuts and controls explicitly false. Disabling a control never removes a
stored mark, changes schema, grants authorization or destroys unknown data.

Collaboration defaults to absent/false. Its connector receives an instance-owned
signal and generation and returns the existing `AttachSyncOptions`. Admission
never creates a provider, subscription, timer, socket or awareness owner.
`readiness: 'local'` is the default even when collaboration is selected; only an
explicit `remote` choice requests a provider readiness gate. Awareness and peer
caret presentation are independent opt-ins; carets require awareness. No sibling
editor obtains the connector, history, selection, authority or mutable options
from shared immutable code. SDK-1.11 proves attach/detach and late-completion
preservation through the existing sync/session ports, without replacing history.

Platform preferences default to platform spelling and inherited autocorrection.
`off` and explicit `custom` are separate spelling modes; none infer effective
user settings, force a checker fallback or couple autocorrection. Requested
policy and observed unknown/supported/unsupported/coupled capability are separate
types. SDK-1.11/EXT-1.18 own actual attribute preservation and platform evidence.

## Loading, interests and authoring boundary

`required-input` features participate in `requiredReady`. `command-lazy` and
`presentation-lazy` features do not delay ordinary typing. Common status is
idle/unavailable/loading/ready/failed/cancelled plus an attachment generation;
failures carry a code and retryability. Loading failure retains source and cannot
silently reinterpret input. One HTTP(S) asset base URL or one asset manifest is
the advanced host override; conventional bundler discovery needs neither.
Admission validates URLs without fetching them. SDK-1.12 owns actual asset loads,
compatible immutable sharing, MIME/CORS/CSP diagnostics and cancellation.

Subscriptions use existing `ModuleScope` operation/source/UTF-16 range/selection
semantics. Authors must specify `kinds`; `[]` is selection-only. Empty interests
mean no input callbacks. The existing ModuleRuntime owns indexed dispatch and
must never gain a per-input registry scan. Binding precedence is settled once
by profile admission. EXT-1.15 proves work counters and disposal, including
selection, format and structural changes, using that same runtime.

Behavior adds no persisted schema. Data semantics require the same admitted
`ModuleDefinition` mark/inline-atom descriptor with text fallback. New Rust
editing semantics, arbitrary schema types or hot schema registration are not
JavaScript authoring options. Descriptor changes require a new admitted session
configuration or safe view remount. Callback context exposes current prepared
command/capture/subscription ports and lifetime signal/generation, never a raw
replica or DOM document. readonly checks, one-intent history, selection results,
unknown data preservation and stable target validation retain their current
owners. onAttach cleanup is idempotent, cancels pending work and removes interests;
late completion must be inert. Helpers and runnable mark/atom recipes are the
EXT-1.15 delivery, not claims established by these prepared contract fixtures.

## Verification boundary

`node scripts/test-extension-dx.mjs --group contract` bundles a public-import
consumer and checks independent admission expectations, typed positive/negative
fixtures and immutable inputs. It rejects unknown/unimplemented groups and
fewer-than-30, failing, skipped, todo or cancelled test sets. No engine instance, attached DOM,
provider or asset is required. These are prepared contract checks; browser,
packed-loading, real history, OS spelling and latency proof remain with their
original downstream gates. Run workspace `npm run typecheck` as well.
