# Immutable review representations

This optional, unpublished companion freezes the DIF-1.1 input contract. It does
not attach to keystrokes, read a live replica, compute a patch or implement a
history store. Named captures are owned copies; callers retain their provenance.

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
engine-to-model adapter belongs to DIF-1.4; prepared snapshots here are fixtures,
not an implemented engine diff. Non-JSON extension values need an explicit
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
