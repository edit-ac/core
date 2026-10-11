# Disposable binary-v1 XML interop fixture

FND-1.3 uses pinned Yrs 0.28.0 (`small-client`) and dev-only Yjs 13.6.33.
The root `interop` is an XML fragment with one `p`, string attributes `id` and
`stage`, and one XML text child. Boolean `bold`, `italic` and `underline` marks
exercise rich text. This is a test fixture, not the frozen editor schema.

`bridge.mjs` generates actual Yjs v1 updates; the Rust integration test generates
actual Yrs updates and consumes the JS bytes. Three transactions initialize
`a😀b é👩‍💻🇭🇺אב`, insert `!` at UTF-16 offset 3, then delete `b` at offset 4
and set `stage=edited`. Both consumers check every permutation of the three
updates, duplicate delivery, and reverse replay against exact semantic text and
attributes. Missing-parent updates are delivered before initialization in four
schedules. Both sides encode state vectors and apply incremental v1 differences.
The JS-origin edit over a Rust baseline uses client 404 versus baseline client
202; the original JS baseline uses 101. Receiver IDs are distinct too.

Fixed IDs and direct offsets belong only to disposable deterministic tests;
production uses the fresh-ID UTF-16 factory and must validate public positions.
Generated binary files live in temporary directories and are removed on teardown.
`EDITAC_INTEROP_OUTPUT` retains them only for evidence capture or the Node harness.
Binary receipt/application asserts CRDT integration only, never durable storage,
acknowledgment, networking, final schema compatibility or anchor correctness.

Run with pinned Node 24.19.0 and Rust 1.97.1 on PATH:

- `cargo test -p editac-core --test interop --locked`
- `node --test tests/interop.test.mjs`

The Node suite invokes the same Rust harness once before its assertions. The
bridge supports `generate-js`, `verify-rust` and `delta-for-rust` with a directory
argument; it uses no provider transport or secrets.
