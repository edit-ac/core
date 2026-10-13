# Native preparation bridge

The authoritative contract is [native-abi.md](../../../architecture/specs/native-abi.md). This crate compiles the existing semantic bridge source and owns one serial Rust executor per opaque handle. Whole command batches return detached patches; checkpoint/update buffers are owned. It is not a mobile SDK.

From the core repository:

```sh
cargo +1.97.1 test -p editac-ffi --test native_abi --locked
cargo +1.97.1 test -p editac-ffi --locked
python3 tests/native/bounded-bindings.py --output ../architecture/evidence/native-preparation/nat-1.2-20261013
```

The generator is the same exactly pinned UniFFI dependency as the runtime. The harness writes both language outputs to `crates/editac-ffi/generated/`, records native build/generator/interface logs and hashes in its output directory, and rejects missing signatures, different offset/buffer mappings or leaked engine types. Generated host execution and real text controls are later roadmap parents. The fixed corpus is `tests/native/fixtures/bounded-abi.json`; it includes an emoji and combining mark to distinguish UTF-16 offsets from bytes and scalar counts.

Swift/Kotlin outputs require their generated foreign-reference teardown plus explicit `dispose()` for prompt worker shutdown. No callback interface exists. Do not issue one FFI call per character or treat detached snapshots as a writable document.
