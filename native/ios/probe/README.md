# Swift headless preparation host

NAT-1.3 runs the actual generated UniFFI bridge and native Rust engine on macOS
arm64. It uses `tests/native/fixtures/bounded-abi.json`, the same corpus and
expectations qualified by `crates/editac-ffi/tests/native_abi.rs`.

From `core`, run:

```sh
bash tests/native/swift-fixture.sh --output /absolute/path/to/new-evidence
```

The qualified toolchain is Xcode 26.6 (17F113), Apple Swift 6.3.3
(swiftlang-6.3.3.1.3), macOS SDK 26.5, on macOS 26.4.1 (25E253), target
`arm64-apple-macosx26.0`. Select `/Applications/Xcode.app/Contents/Developer`
with `DEVELOPER_DIR` when reproducing this version. Compile in Swift 5 language
mode with `-Onone`. The script records actual versions and exact commands;
a different toolchain needs its own receipt.

The build links the qualified `target/debug/libeditac_ffi.dylib` with
`-L target/debug -leditac_ffi -Xlinker -rpath -Xlinker target/debug`, includes
`crates/editac-ffi/generated`, and passes
`-Xcc -fmodule-map-file=crates/editac-ffi/generated/EditacNativeFFI.modulemap`.
Paths are resolved absolutely by the script. It verifies the existing NAT-1.2
source, fixture, generated-interface and library hashes before reuse; a mismatch
requires rebuilding/regenerating and requalifying that prerequisite. The native
library's exact Cargo build command is retained in the referenced NAT-1.2 receipt.

The unchanged generated Swift source is compiled with `main.swift`. One narrow
Unicode case precedes eight named semantic cases: schema, Unicode atomic
commands/patches, checkpoint restore, remote update/anchor/history, typed errors
without mutation, cancellation/commit/disposal, final ARC release, and all 256
byte values through the actual generated record codec. Restore/update use real
CRDT bytes; the codec case is separately identified. Every case asserts its
expected result and the process fails on zero matching cases, failures or skips.

Explicit disposal is idempotent; aliases observe typed `Disposed`. Detached
checkpoints/patches remain usable. Weak-reference release observes Swift ARC;
Rust executor joining is qualified by NAT-1.2 ownership tests, rather than inferred
from Swift timing. Every created engine is disposed on success/failure, except
the deliberate final-reference ARC case.

A second disposable build inserts counters at exact generated engine-call and
conversion sites. It checks one two-command batch call, input buffer bytes,
output string bytes, and restore JSON/binary copies. Checked-in generated output
is untouched. These are executed conversion-site observations, excluding Rust
staging copies, allocation internals and timing. No zero-copy or performance
claim is made. Temporary sources and executables are removed in teardown.

After a measurement-only repair, `--reuse-semantic` verifies unchanged semantic
source, fixtures, generated bindings, library and passing log hashes before
reusing the semantic results. The normal command builds and runs every case.
Full logs and receipts remain in the selected evidence directory; use a new
directory for a fresh qualification and preserve failures before a repair.

This host supplies macOS headless Swift preparation evidence. UIKit/TextKit,
marked text, native input, accessibility, SDK packaging and device/release support
remain subsequent gates.
