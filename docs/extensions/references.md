# Host-controlled references

Import `referenceSuggestions`, `ReferenceLookupSession` and `ReferenceHostV1` from
`@edit-ac/web/modules`. Pass a version-1 host to `referenceSuggestions(host)` when
mounting the existing editor surface. The host owns four ports:

- `permission()` returns the current principal/catalog policy revision and separate
  lookup/insertion permissions. Replace the revision on any permission, principal,
  catalog or lease change; notify subscribers immediately, including lease expiry.
- `catalog(targetId)` is a synchronous **read-only local** shared-client catalog
  lookup. Use the owning `editac-session::locator::Catalog` for ac locators and
  configured app links. It validates authority allowlists, exact document identity,
  epochs/profiles and explicit host-granted source bindings. Return the exact
  admitted identity and resolution status; never fetch/create a document or return
  filesystem paths, credentials, transport configuration or secret metadata.
- `resolve({query, requestId, signal})` searches only after explicit user activation.
  Any remote search needs the host's current authorization and configured service
  adapter. Return bounded `{targetId,label}` records only. Respect the abort signal;
  the library also suppresses providers that ignore it.
- `subscribe(listener)` returns a disposable policy notification subscription.

Only local, cached and hosted catalog outcomes admit new suggestions. Locked,
unavailable, unauthorized and incompatible results fail the whole result set;
partial unsafe responses do not publish UI. A permitted hosted identity is metadata,
not fetched content or permission to edit that target. Canonicalize configured HTTPS
app links to their admitted ac identity in the host before returning suggestions.
Document IDs identify mutable documents, not immutable content hashes. They confer
no bearer authority.

The library rechecks the host policy and catalog after asynchronous search and at
activation. The browser presenter additionally checks the retained anchor, current
read-only state and engine applicability, then calls the existing shared commit
boundary. Revocation cancels pending search and dismisses its UI. Errors display a
fixed diagnostic rather than host exception text. Cancellation, supersession,
composition, target changes and repeated disposal reject late work. Existing storage
and command middleware retain atomic journal admission and one explicit undo group.
Hosts must keep their commit callback subject to the current session capability;
a resolver result never grants a mutable engine/session escape.

Opening or rendering a document performs no search, catalog lookup, asset fetch or
permission grant. Existing reference tuples and label fallbacks survive offline
restore, copy/export, absent presenters and unrelated edits unchanged. Resolver
callbacks and policy state are transient host objects, never CRDT data.

The original `referenceSuggestions(callback)` remains a compatible explicit
host-controlled port for bounded opaque identifiers. Its callback is responsible
for catalog and authority admission. New catalog integrations should use the typed
host so the library enforces revocation and current-policy checks. Headless platform
hosts can use `ReferenceLookupSession`; downstream renderers own actual UI/device
qualification. This contract does not register OS deep links or launch documents.

Qualification: `cargo test -p editac-core --test extension_references --locked`,
`cargo test -p editac-session --test extension_reference_catalog --locked`, and
`node --test tests/extension-references.test.mjs`, with an isolated absolute
`EDITAC_EXTENSION_REFERENCES_OUTPUT` shared by the Rust/Node harnesses. Packed actual
browser probes use `node scripts/test-browser.mjs references`. These deterministic
fixtures prove the host/library boundary, not a deployed authorization service.
