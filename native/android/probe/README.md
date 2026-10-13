# Kotlin headless native preparation probe

Run from `core`:

```sh
bash tests/native/kotlin-fixture.sh
```

The harness pins Gradle 8.14 (distribution SHA-256 checked), Kotlin 2.2.0,
JNA 5.17.0 and Gson 2.13.1. Dependencies are locked in `gradle.lockfile`.
It uses the installed Homebrew JDK 17 at
`/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`; set
`EDITAC_NATIVE_JAVA_HOME` to another JDK 17 installation when needed.
The receipt records the actual JVM/compiler/Gradle versions and commands.
Builds use a temporary fixture-owned Gradle home, at most two workers,
an in-process Kotlin compiler and `--no-daemon`. Temporary builds and
caches are removed on exit. The checksum-verified Gradle distribution
cache is under `target/native-tooling`.

This JVM host executes the checked-in UniFFI 0.32.2 Kotlin bindings against
`target/debug/libeditac_ffi.dylib`, explicitly loaded through
`uniffi.component.editac_ffi.libraryOverride`. The prior NAT-1.2 receipt
must match the Rust sources, generated bindings, shared fixture and native
library before compilation. It qualifies only `aarch64-apple-darwin` on
macOS arm64. Its Gradle application distribution contains a JVM jar and
pinned dependencies; the native library is loaded by absolute path. This
is headless packaging evidence, not an Android AAR or Android ABI build.
Android cross-compilation, emulator/device execution and EditText controls
remain unqualified here.

The integrated session/diff workspace changes are recognized separately:
the original manifest/lock are recovered from the qualification commit and
checked against their receipt hashes. Only those member additions, new locked
packages and hashbrown's added foldhash dependency are accepted. This feature
change requires fresh nonempty Rust FFI tests and a native library build in
`target/native-kotlin-qualification`, followed by the full Kotlin host checks.
The prior Swift-qualified library is preserved. Receipts record the manifest
delta, Rust results and the actual loaded library hash; any other qualified
source, lock or generated-binding drift is rejected.

UniFFI 0.32.2 generates four typed-error payload fields named `message`
that collide with its synthesized `Throwable.message` properties. The harness
applies a guarded compatibility transform to a temporary binding copy: one
`override val message` per affected variant, retaining wire field order and
codecs. The receipt records its reason, count and source hash. The checked-in
generator output and native ABI are unchanged. This defect requires attention
before production packaging.

The narrow Unicode case precedes eight integration cases using the same
`tests/native/fixtures/bounded-abi.json` expectations as Rust and Swift.
They cover schema/profile, UTF-16 batch patches, checkpoints/restore,
real CRDT update bytes and portable anchors/history, typed atomic failures,
prepare/cancel/commit/dispose, explicit foreign close and all byte values.
Owned output survives disposal. `dispose()` stops the engine while keeping
the foreign handle usable for typed `Disposed` failures. `close()`/`use`
releases the UniFFI handle; repeated close is safe and subsequent use is
rejected. GC finalization timing is not asserted. Rust's previously
qualified Drop owns executor joining.

A separate compiled build instruments disposable generated-source copies
and runs one measured case. It observes batched engine calls, UTF-8 string
copies, byte-array copies and owned output decoding. Checked-in generated
bindings remain unchanged. Counts describe those observed sites, excluding
JNA internal copies, Rust staging, allocation internals and timing; they
are preparation evidence, not performance qualification.

The default durable receipt/log/source archive directory is
`../architecture/evidence/native-preparation/nat-1.4-20261013`.
Failures retain their receipt and logs in a hash-named subdirectory.
Missing tools, failed builds, empty filters and skipped cases fail the gate.
No provider, network transport, content migration, Android device,
SDK parity, publication or release is exercised by this fixture.
