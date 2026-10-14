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

## Producer and consumer records

`producers.json` is the reviewed producer list. The iOS, Android and desktop
`native/*/capability.json` records are explicit pending SDK producers. Their
control preparation sources are present, while editor SDK read/write support is
unavailable and unqualified. Implementation identities name the existing
`editac-ffi` preparation crate and pin its package manifests; no SDK package is
invented. Desktop has no control preparation producer. The adapters preserve original NAT-1.5/NAT-1.6
receipt counts, target-runtime provenance and source hashes. Historical passing
preparation is not current SDK support; `inputDrift` lists changed source inputs.
No preparation test, native build or simulator is launched by the adapters.

Generate the shared build artifact from core:

```sh
node scripts/release-profile.mjs --output /new/path/release-profile.json
node scripts/check-architecture.mjs --suite profile-producers
```

The generator refuses an existing output. Its stdout supplies the artifact's
SHA-256; the JSON also contains a deterministic `contentRevision`, producer code
hashes, manifest hash and full shared profiles. Profile source hashes, exact
implementation/package/version tuples and original evidence identities travel
with every record. `consumeRelease(bytes, reviewedSHA256)` in
`scripts/profile-producers.mjs` returns the same rows for docs support tables,
demo controls and cloud compatibility consumers. Pin that SHA-256 through the
consumer's reviewed distribution configuration, never from imported content.
This task defines the consumer format without deploying or changing those apps.

Rows distinguish capability state from owning SDK support. A pending row cannot
advertise support. A supported row still does not enable a provider or grant host
permission: `authorized` remains null, `enabled` is independent, and the existing
`resolveCapability` requires current principal-specific host answers. Portable
inventory remains scoped metadata, not release qualification. Resource budgets,
converter fidelity and publication retain their owning gates.

To admit future native SDK support, its owner supplies a reviewed policy and
receipt through the manifest's `qualification` references. Both references pin
repository-relative paths and exact hashes. The policy binds `identityHash`
(implementation/package, version tuple, platform and source input pins), owner
(`16-ios-sdk`, `17-android-sdk` or `18-desktop-native`), named runtime, required
read/write capability cases and packaged library/evidence artifacts. The shared
profile must link the receipt hash with `native.sdk` and exact capability scopes.
The receipt must match the policy, enumerate every required case exactly once,
and pass with positive executed counts and zero failures/skips. Runtime case
artifacts are separately hashed and checked for matching implementation, case,
runtime, direct observation or executed virtual equivalent and tested fallback.
Deferred physical observations must name a passing virtual-equivalent case.

Accepted runtime kinds are iOS `physical-device`/`simulator`, Android
`physical-device`/`emulator`, and desktop `physical-device`/`vm`/`os-host`. Review
the policy against the owning track's full acceptance before registering it;
the generator cannot decide whether an owner omitted a required SDK behavior.
Missing physical hardware alone is never a reason to reject an otherwise valid
virtual record. `tests/architecture/profile-producers/fixtures/` models this
admission contract only and is excluded from production producers.
