# Capability and compatibility profiles

`../capabilities.schema.json` is the version 1 reviewed inventory contract. Validate
with `node scripts/check-architecture.mjs --suite profiles` from core. The checker
shares its dependency-free schema validator and capability states with the existing
extension inventory; it preserves that inventory's scoped proof and owner checks.
These are build-time contracts, outside the shipped SDK dependency graph.

Each profile pins implementation/package identity, the semantic/sync/descriptor/API/
ABI/dialect tuple, converter directions and fidelity, platform, resource limits,
and source/evidence inputs. Implementation revisions are immutable Git commits;
evidence revisions are SHA-256 content identities, bound to an implementation
commit and named scopes. `verifyProfileInputs` verifies local artifact hashes,
repository containment and input blobs at the implementation commit. Qualification
requires evidence for the exact capability or resource scope. Prepared evidence
cannot qualify a target platform. Producer/runtime qualification remains FIT-1.3;
converter fidelity and resource measurement require their own owning gates.

The portable editor record migrates the existing schema-v5/extension API/native ABI
vocabulary by reference to their exact source inputs. Its availability describes
implemented portable primitives. Activation, qualification and resource qualification
remain false. It declares no converters or platform support. Source bounds are
implementation admission limits, not measured performance or qualified envelopes.
Do not treat the package's scaffold version as a publication claim.

The four states are independent:

- `available`: implemented functionality is present in the reviewed inventory.
- `enabled`: reviewed configuration enables it; a current host can disable it.
- `authorized`: always null in imported/static records. Only a current principal's
  host permission answer supplies authorization through `resolveCapability`.
- `qualified`: the named scope has linked evidence; it cannot imply activation,
  permission, or broader OS/input/resource support.

A capability is usable only when all four runtime states hold. A permission grant
cannot supply a missing capability, provider, activation or qualification.
`extensionCapabilityState` translates the existing scoped portable/browser-mechanics
statuses without copying the 210-cell inventory or claiming pending platform parity.

`admitProfile` accepts serialized data bounded to 64 KiB, depth 32 and 8,192 nodes.
Unknown contract versions or unsupported exact version tuples remain unchanged,
inert bytes for read/copy/export. They cannot write or install providers, and their
claims are never used for runtime authorization. Known tuples admit profile metadata;
this does not authorize document mutation. Malformed known profiles fail explicitly.
The caller supplies trusted supported records and current host answers; imported
records and peer advertisements cannot provide those answers. Exact version tuple
admission makes no migration/rollback or historical support promise (FIT-1.5).
