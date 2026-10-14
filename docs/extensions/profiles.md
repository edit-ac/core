# First-party configuration profiles v1

Import `FIRST_PARTY_PROFILES`, `FIRST_PARTY_FEATURES`,
`prepareExtensionProfile` and `ExtensionProfileActivation` from
`@edit-ac/core/extensions`. These exports contain metadata and lifecycle helpers;
importing them does not load a feature, presenter, worker or transport.

The `core` profile has no optional features. The host keeps its qualified baseline
input, selection, accessibility, history and command implementation. `document-tools`
names slash, references, reorder, images, tables and search at version 1.
`code-tools` names slash, math, code and pairs at version 1. Search, code and pairs
are **contract fixtures**, owned by their downstream tracks. Production admission
rejects those pending features. Only prepared conformance hosts set
`allowContractFixtures: true`. Profile qualification does not qualify FPX-04's
table/search/history, code/pairs/IME or link/slash/replacement combinations.

Call `prepareExtensionProfile(profile, catalog, environment)` before activation.
It validates the entire configuration without a document handle or callback:
exact preset versions, inclusive dependency version ranges, schema, capabilities,
explicit permissions, conflicts, duplicate IDs and binding conflicts. Required
host permissions are admission requirements, never grants. A reference resolver
still checks authority on each activation. The data registry is frozen before
attachment; module descriptors use the existing bounded registry validation.
The helpers never migrate a document or interpret existing data under a new version.

The result uses canonical dependency order. Command, keymap and input-rule binding
candidates use declared numeric priority; equal winners reject. Explicit host
remaps choose a named candidate and appear in diagnostics. Default commands are
metadata obligations for the owning host command registry, not a new dispatcher.
The profile fixture suite exercises keymap/input-rule precedence with known fixtures.
Every feature declares host focus ownership, nested-control/composition exclusions,
host text/block drag ownership, prepared selection results, one-intent history,
platform presenter obligations, cancellation and idempotent teardown.

`ExtensionProfileActivation(prepared, timeoutMs)` invokes only selected host
loaders. Check all required loader identities before starting. A loader receives
an abort signal and returns an idempotent disposer; it must allocate resources
exception-safely, cancel/terminate its own workers and bound worker input/output.
Startup failure rolls back acquired resources. Disposal invalidates pending work,
releases resources in reverse order and cleans up a late loader completion.
Missing features invoke no loaders. No resources are stored in document state.

Use `activation.work(run, validate, revision)` for bounded optional host work.
It admits one in-flight job, rejects concurrent work, enforces the deadline,
rejects malformed results and rechecks revision/cancellation after validation.
Route the returned proposal through the existing `ExtensionCommandSession` and
host capability/atomic preparation boundary; this helper grants no write access.
Timeout does not preempt an infinite loop in the same thread. Trusted callbacks
must finish; heavy/untrusted work belongs in host worker/process boundaries.

Unload a presenter by cancelling its command session and disposing its activation
and subscriptions. Keep the frozen data registry and original checkpoint. Reopening
with absent descriptors uses the existing opaque/literal fallback; custom metadata
that Markdown cannot represent requires the original checkpoint recovery, not a
claim that plain text preserves it. Never rewrite source or reset selection/history
as a side effect of configuration. `ModuleRuntime` isolates presenter and postcommit
observer failures and retains committed edits.

Reproduction: `npm run build`, then
`node --test tests/extension-profiles.test.mjs`. The packed suite covers FPX-01–03
and FPX-05–08 with production WASM, real browser middleware and prepared optional
feature loaders. Native/device/rendering and real future-feature combinations
remain with their platform and feature owners. No package publication is implied.
