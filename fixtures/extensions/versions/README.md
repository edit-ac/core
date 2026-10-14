# Codec and evolution conformance

`conformance.json` is the EXT-1.4 fixed corpus: 12 candidate-version cases,
7 source/codec cases and 4 opaque preservation cases. Rust creates 13 real
Document checkpoints (codec, opaque, reference and new-epoch); web restores
those checkpoints through the production WASM engine and compares semantic data.

Enabled image/table/callout codecs and formatted text have semantic Markdown
round trips. Disabled image/table codecs and literal text preserve exact recovery
fragments with `markdown-unrepresentable`; their Markdown alone is not a lossless
export claim. The fixture selections exclude the empty landing paragraphs required
around inserted content atoms. Structured clipboard copy/paste retains module data.
Reference export preserves its identity in recovery with an explicit diagnostic.
Future blocks/marks/atoms and disabled math retain original bounded data through
source edits elsewhere and checkpoint restoration; unsupported changes reject.

Candidate migration validates old and new descriptor data without a Document
handle. Discarding or failing preparation cannot mutate a document. It is not an
engine edit or an epoch grant. The separate epoch case exercises the existing
Tiptap migration preparation/new-session protocol and rejects delayed old-epoch
updates in Rust and production WASM. Registration does not migrate live state.

Use Node 24.19.0 and rustup 1.97.1, fresh owning package/WASM builds and an absolute,
worktree-owned `EDITAC_EXTENSION_CODECS_OUTPUT` directory. Run in this order:

```sh
cargo test -p editac-core --test extension_codecs --locked
node --test tests/extension-codecs.test.mjs
```

The Node suite requires the Rust artifacts; missing artifacts fail, never skip.
No providers, credentials, network transport or device support is exercised.
See `architecture/evidence/extension-codecs/receipt.json` in the sibling repository
for immutable source/artifact hashes, full logs, counts and preserved failures.
