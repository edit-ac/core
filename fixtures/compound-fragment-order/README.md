# Compound fragment ordering regression

These deterministic, synthetic v5 checkpoints were captured from the packed Markdown-enabled Task consumer while qualifying SDK-1.8. The first owner (`n:1923565734:1`) contains `prefix alpha 😀literalBISUCLG` with rich marks; later owners retain a versioned image and table.

`before-enter.bin` is the valid precondition. `after-enter.bin` preserves the old failing terminal Enter result: its first owner becomes empty and the rich body moves behind the optional content. It is a historical negative control, not a correct expected editor result. `receipt.json` records provenance, identity and hashes.

`crates/editac-core/tests/compound_fragment_order.rs` restores the same state and qualifies rich replacement, append, terminal split/join, stored-content order, checkpoint restore and peer updates through production prepared commands. `tests/compound-fragment-order.test.mjs` checks the compiled engine and returned caret. `tests/browser-size-runtime.test.mjs` supplies the real keyboard/surface/storage/protocol integration on the measured packed artifacts and records each phase checkpoint.
