# NAT-1.5 UIKit/TextKit preparation probe

From `core`, execute the named build/run check once the implementation is ready:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  bash tests/native/ios-control.sh --output \
  /Users/bpstr/Github/edit-ac/architecture/evidence/native-preparation/nat-1.5-20261013
```

Pinned host: Xcode 26.6 (17F113), Swift 6.3.3 in Swift 5 language mode,
iOS Simulator SDK/runtime 26.5 (23F77), iPhone 17 simulator, Apple silicon.
The harness checks Xcode/SDK versions and records actual Swift/runtime versions.
It creates its own simulator, preserving any simulator used by another task.
It terminates the app, shuts down and deletes only its own simulator in teardown.
No browser, WebView, server, network/provider or real user content is involved.

The exact commands, exits, versions and hashes are in `receipt.json` and named
logs. Its canonical compile commands are:

```sh
cargo +1.97.1 build -p editac-ffi --lib --target aarch64-apple-ios-sim \
  --target-dir target/native-ios-control --locked
xcrun --sdk iphonesimulator swiftc -swift-version 5 -Onone \
  -target arm64-apple-ios26.5-simulator -sdk <recorded-sdk-path> \
  -parse-as-library -I crates/editac-ffi/generated \
  -Xcc -fmodule-map-file=crates/editac-ffi/generated/EditacNativeFFI.modulemap \
  native/ios/probe/UIKit/Probe.swift crates/editac-ffi/generated/EditacNative.swift \
  target/native-ios-control/aarch64-apple-ios-sim/debug/libeditac_ffi.a \
  -framework UIKit -framework Foundation -lc++ -o <temporary-app>/NativeControlProbe
```

The harness packages/signs the executable as a simulator app, installs and launches
it with `xcrun simctl`, and copies the actual app's atomic `Documents/result.json`.
It requires exactly seven named passing cases, zero failures/skips. A missing
result or zero cases fails. Full failed evidence is preserved in a new output
directory; repair relevant code before rerunning in another directory.

Cases cover a real UITextView with TextKit 1, two-command local UTF-16 patch and
caret, real remote CRDT patch and selected range, marked text kept outside Rust
with remote projection queued until explicit cancellation, custom native mark,
inline NSTextAttachment, bounded engine-call/replacement counters and typed
Disposed. Text expectations use the Rust/Swift/Kotlin fixed Unicode corpus.
Patches replace only a scalar-aligned changed range in NSTextStorage; offsets and
selection are NSRange UTF-16 units. Counters record executed adapter sites and
actual patch/update sizes, rather than estimated engine allocations.

The selected composition policy cancels marked text then flushes the remote patch.
It does not qualify conflict-preserving IME commits, keyboard candidates, real
IME/autocorrect/dictation, undo, clipboard, accessibility, persistence, reconnect,
packaging or physical devices. Mark and attachment rendering are native presenter
observations; engine semantic import/export and attachment identity remain gaps.
Changed-node JSON decoding, flattened strings and scalar arrays copy whole node
content; composition cancellation restores the whole committed control string.
Rust/UIKit internal allocations, latency, footprint and release gates are
unmeasured. No SDK or cross-platform parity follows from these preparation cases.

Review `result.json`, the retained binary/source/fixture hashes, build/run logs and
`control.png`. The screenshot is supplemental; actual assertions establish the
seven cases. Subsequent native SDK/device owners must qualify the listed gaps.
