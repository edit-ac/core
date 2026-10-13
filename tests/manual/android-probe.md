# Android real-control preparation probe

Run from `core` with the installed macOS arm64 Android SDK:

```sh
bash tests/native/android-control.sh
```

This canonical harness uses Rust 1.97.1, NDK 27.1.12297006/r27b,
`aarch64-linux-android` API 35, SDK API 36/build-tools 36.0.0, checksum-verified
Gradle 8.14, Android Gradle Plugin 8.10.1, Kotlin 2.2.0, JDK 17,
JNA 5.17.0 Android AAR and Gson 2.13.1. Dependency locks are retained.
It packages the real UniFFI 0.32.2 shared library in an arm64-v8a debug APK.
The generated binding compatibility transform and copy-site instrumentation
are the guarded transforms already used by NAT-1.4; original bindings remain
unchanged. The receipt retains original/transformed/source/native/APK hashes.

The harness records fully resolved commands, directories, exits and log hashes.
Its pinned build and control commands have this form (temporary paths, AVD
name and reserved port are resolved in the receipt):

```sh
cargo +1.97.1 build -p editac-ffi --lib --locked --target aarch64-linux-android --target-dir target/native-android-control
target/native-tooling/gradle-8.14/bin/gradle --no-daemon --console=plain -p "$PROJECT" -PbindingsDir="$BINDINGS" -PfixtureDir="$ASSETS" -PnativeDir="$JNI" assembleDebug
"$SDK/platform-tools/adb" -s "$SERIAL" install -r "$APK"
"$SDK/platform-tools/adb" -s "$SERIAL" shell am start -W -n ac.edit.controlprobe/.ProbeActivity --es case native-control-unicode
"$SDK/platform-tools/adb" -s "$SERIAL" shell am start -W -n ac.edit.controlprobe/.ProbeActivity
"$SDK/platform-tools/adb" -s "$SERIAL" shell run-as ac.edit.controlprobe cat files/result.json
```

The first build resolves locks with `--write-locks`; subsequent builds enforce
the checked-in graph. Every invocation creates a separate API 36 Google APIs
arm64 AVD, runs without snapshots/window/audio, and terminates only its emulator.
No existing AVD, emulator, app or shared adb server is stopped. APK build output
and AVD are temporary; this harness's Gradle dependency cache is retained during
repairs under `target/native-android-control/gradle-home` and cleaned at the
delivery checkpoint. Durable logs, source archive, APK and receipt
are under `architecture/evidence/native-preparation/nat-1.6-20261013`.

The narrow actual-control case precedes seven actual Activity assertions using
the shared bounded-abi corpus: real EditText Unicode/UTF-16; batched local range
patch and selection; real CRDT remote update and range selection; InputConnection
begin/end batch and composing spans with Rust ownership and remote queue; native
custom background mark; inline ImageSpan attachment; measured generated binding
and control projection/replacement copies plus explicit handle close.
Failures, missing results, zero matches and skips fail qualification.

The probe explicitly cancels temporary composing text before flushing remote
committed output. It does not qualify composition merging or committing, physical
devices, actual keyboards/candidate UI/autocorrect/dictation, semantic native
marks or attachments, clipboard, accessibility, storage/reconnect, SDK parity,
performance or release. Copy counts observe instrumented generated conversions
and presenter string/range operations; JNA internals, Rust staging, allocations
and timing remain unmeasured. The custom mark/attachment demonstrate platform
presentation only and never mutate a second committed model. There is no WebView.
