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

DIF-1.3's `repeated-before.md`, `repeated-after.md` and `repeated.patch` pin the
exact-source patch v1 wire bytes independently of the Rust encoder. The first
line is bounded versioned JSON metadata; the remaining fixed `before`/`after`
labels, one-based unified ranges (zero-count positions are zero-based), prefixes
and missing-final-newline marker carry literal UTF-8. CR is part of line content.
The metadata pins SHA-256, final newline, source profile, context=3, line LCS
(common ends trimmed, delete-first ties) and optional Unicode whitespace-run word
LCS. This local golden is not Git version interoperability qualification (DIF-1.8).

Named check: `cargo test -p editac-diff --test text_patch --locked`. Generation,
encoding, decoding and pure application are bounded by caller and carried limits;
caller limits always win. Defaults: 5 MiB source/output, 16 MiB wire, 100,000 lines,
4,096 hunks and 4,000,000 LCS cells. Small local edits trim common ends; larger
unmatched replacements can return `ResourceLimit`, with no fallback approximation.
`word_changes` retains whitespace and Unicode spelling as separate inline detail.
Application is all-or-nothing and returns a new byte buffer after validating both
hashes and every range/context. Applying to a live replica is still DIF-1.5.
