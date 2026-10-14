# Bounded derived-service lifecycle

Run from core with Node 24.19.0:

```
node scripts/check-architecture.mjs --suite service-lifecycle
```

The suite builds the current TypeScript adapters into its isolated receipt
directory and executes deterministic highlight/asset/resolver/conversion
providers against one harness. Shared TSV cases are checked by both TypeScript
and Rust. The embedded Rust command runs the whole named `service_lifecycle`
integration target with nonzero exact counts and no skipped/filtered tests,
including actual local-session journal/acknowledgment preservation. Raw TAP,
Rust log, bundle hashes, implementation inputs and registration inventory are
retained. Rejected requests never invoke providers. Cancellation and deadlines
settle promptly without pretending an uncooperative provider has terminated.

The production `ReferenceLookupSession` is exercised with actual host-port
permission/catalog callbacks, scope replacement, saturation and deadlines.
Its presenter supplies engine document identity and relevant-node subscription revision and keeps existing
stable-anchor revalidation at semantic commit. Owning reference regressions
also exercise real engine/storage/DOM presenters and packed browser adapters.

Only the resolver is currently registered as an actual async adapter. The
other families are deterministic contract providers, pending their owning
tracks; they establish neither runtime support nor resource/format fidelity.
The lifecycle has no journal write/delete path. `ready` is derived data, not
save acknowledgment, and callers revalidate its retained scope before apply.
