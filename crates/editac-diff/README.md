# Immutable review representations

This optional, unpublished companion captures immutable representations, computes
bounded exact/semantic diffs and exports presentation models. It installs no
typing hook or history store. Named captures are owned copies; callers retain
their provenance.

`ImmutableRevision::capture` takes a `RevisionScope`, a typed `RevisionInput` and
explicit limits. Exact source retains valid UTF-8 bytes without newline, BOM or
spelling normalization. NUL binary content and invalid UTF-8 return diagnostics.
Projected Markdown additionally requires explicit serializer and dialect version
identities; its label warns about normalization. A CRDT transport input is always
rejected, including transport buffers that happen to be valid UTF-8. A caller
must not mislabel an update as source.

Semantic v1 is `editac-semantic-json-v1\n` plus compact JSON with recursively sorted
object keys. Array order is significant. Stable IDs, placement, attributed runs,
UTF-16 source spans/integrated identities, block attributes, editor metadata,
opaque JSON tuples, recovery nodes and retained structure are explicit. The
on-demand `semantic::capture_projection` adapter reads the engine projection
without changing the live replica. Non-JSON extension values need an explicit
lossless tagged encoding before crossing this JSON contract, never silent drops.

Hashes are SHA-256 of retained representation bytes (including the semantic
version prefix), not of CRDT updates. Hashes are not signatures or author evidence.
Compare only within matching document/epoch/schema/module and representation
profiles. Observed session tokens bind captures to observed state, including
removals, and are equality validators; equal content hashes do not imply equal
observed tokens, causal order, currentness or permission to apply changes.

Limits cover bytes, semantic nodes and nested JSON depth. Borrowed fields are
budgeted before copying; serialization also has an output cap including escaping.
Captures expose only read access and Debug excludes source content. The retention
policy bounds count and aggregate encoded bytes; DIF-1.2 must enforce it in actual
storage. Availability distinguishes missing, pruned, key-unavailable and
incompatible-schema revisions, with no fallback to a live document.

Check: `cargo test -p editac-diff --test representation --locked`.
Goldens: `../../fixtures/diff/` (independently recorded SHA-256 values).

`portable::ChangeModel::new(ChangeInput)` plus `encode(max_bytes)` exports
`editac-change-model-v1`. Native/terminal consumers use `decode(bytes,max_bytes)`
and choose presentation/column conversion themselves. Source and projected
Markdown preserve unified wire and hashes; projected metadata warns about
normalization. Semantic input retains independent move/content/formatting/link/
opaque facets and unknown attribution. This data is not permission to apply an
edit, an authenticated author claim or a causal timeline. `MAX_BYTES` is an
upper bound; callers should set their own smaller display budget.

The optional web companion exposes `exportChangeModel(input,limits)` and
`importChangeModel(wire,limits)` for the same envelope before `ChangeReview`.
Checks: `cargo test -p editac-diff --locked` and
`npm run test:browser -- review-concurrent`. Git interoperability goldens pin
Git 2.53.0 and profile options in `fixtures/diff/git-goldens.json`; they distinguish
real differences from Git error diagnostics and independently apply patches.
Terminal/native presenter implementations, device and release performance are
outside this exported-model qualification.
