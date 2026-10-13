# Revision representation fixtures v1

Literal UTF-8 byte files preserve their checked-in newline spelling. `goldens.json`
records SHA-256 of literal text bytes, or of the semantic encoding
`editac-semantic-json-v1\n` followed by compact JSON with recursively sorted object
keys. Arrays retain order; offsets in future semantic commands remain UTF-16.

Semantic fixture changes isolate bold-only formatting, stable-ID placement moves,
and deletion. Source spelling changes have distinct exact hashes while their
prepared Markdown projection may agree. Projection agreement is normalization
evidence, never original-source fidelity. Unicode has combining text and emoji.

Named check: `cargo test -p editac-diff --test representation --locked`.
These inputs are prepared contract fixtures, not live-engine diff, history-store,
Git compatibility, provider quality or browser qualification.
