# macOS native SDK

DSK-1.1 builds an AppKit SDK target, a windowed native test host and one real
XCTest case. The text view remains noneditable until the input and projection gates.
DSK-1.3 binds the actual shared Session through its generated Swift interface. This bootstrap establishes no editing, toolkit feasibility,
IME, accessibility or release support. All capability claims start unqualified.

From `core`:

```sh
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
bash native/macos/scripts/check.sh bootstrap
```

The dispatcher requires the exact Xcode, Swift, SDK and test-host versions in
`toolchain.json`, Node 24.19.0, a macOS GUI login session, and Python 3. It builds both arm64
and x86_64 slices with a macOS 14.0 deployment minimum. The declared deployment
range is 14.0–26.5; only the pinned arm64 host executes tests. The x86_64 slice
is compile evidence, not runtime qualification. Other OS/CPU environments need
their own future qualification. No signing, publication or external service is
involved. AppKit's native text system is the candidate; DSK-1.2 owns TextKit and
cell/atom feasibility rather than this bootstrap.

Each invocation writes full commands, tool versions, logs, counts, source and
binary hashes to a unique `core/.artifacts/macos/bootstrap-*/receipt.json`.
Build outputs are isolated under `core/target/native-macos/`. Tool/build/test
failures, unknown suites, missing tests, zero matches and skips fail the check.
Future named suites must be implemented before the dispatcher admits them.
The test host exits automatically with `--smoke`; without that flag it displays
a native window until closed. Neither route loads credentials or calls providers.

`python3 -m unittest discover -s native/macos/tests -p 'test_*.py'` exercises
dispatcher count admission separately from the actual native XCTest.

Native control availability and architecture:
[Apple NSTextView](https://developer.apple.com/documentation/appkit/nstextview),
[Apple text system organization](https://developer.apple.com/library/archive/documentation/TextFonts/Conceptual/CocoaTextArchitecture/TextSystemArchitecture/ArchitectureOverview.html).
These established AppKit APIs predate the declared minimum; newer APIs need
explicit availability guards and their own qualified runtime cases.

The [native control probe](probe/README.md) selects explicit TextKit 1 and
exercises real composition, cell and atom child-control feasibility with the
`toolkit` dispatcher suite. This does not enable production editing or qualify
IME/platform support.

## Shared Session lifecycle

`NativeEditorView.session` owns a `NativeSessionExecutor`. Call `open(options:initial:now:)`
with a host-granted absolute SQLite path, canonical document/epoch identity and
explicit host clock. Omit `initial` to restore; supply it only for explicit local
creation. Completion results and `onResult` run on MainActor in submission order.
The native view retains an owned session snapshot and typed failure state; rich
text projection remains DSK-1.4. Session calls and final handle destruction execute
on one background serial queue, using the delivered Rust Session and NativeStore.

`submit` accepts shared read, prepare/commit/cancel, history, permission and recovery
operations. It exposes owned values, never the mutable Rust handle. Cancelling a
returned operation prevents queued work from starting and delivers an ordered
`.cancelled` failure. Cancellation after acceptance returns false; it cannot undo
an accepted commit. Cancelling a prepared token uses `.cancelPrepared` explicitly.
Call `view.dispose` at the embedding host's document/view close boundary. It stops
admission, cancels queued work, clears observers, and suppresses late results.
Its optional completion is a shutdown barrier after accepted work and shared
Session disposal. Repeated disposal is safe; final owner release also schedules
cleanup. Removing a view from a window alone does not close its document session.

Run `bash native/macos/scripts/check.sh session` for actual AppKit/generated-Swift/
Rust/SQLite lifecycle integration. The dispatcher builds both CPU slices with Rust
1.97.1 offline and runs twelve XCTest cases on the pinned arm64 macOS OS host.
`Bindings` links directly to the existing generated sources; it defines no second
model. SwiftPM uses `EDITAC_MACOS_FFI_LIBRARY_DIR` to link the dispatcher-built Rust
slice. Clean distributable consumer packaging belongs to DSK-2.1/2.2. This suite
uses deterministic content and native protocol calls; it qualifies no IME,
physical device, full SDK or release support.

## Text projection prerequisite (DSK-1.4-P1)

`bash native/macos/scripts/check.sh projection` runs the text-only projection
prerequisite against the actual generated Swift Session, Rust/SQLite and mounted
AppKit control. Eight cases exercise real Session reads/commits and native storage;
two cases inject malformed/unacknowledged DTOs to test presentation guards. The
suite does **not** close DSK-1.4 or qualify rich content, attachments or IMEs.

`NativeEditorView.projection` consumes the owned Session read on MainActor. It
keeps presentation objects by node ID and replaces only the scalar-aligned changed
storage range. Public coordinates use UTF-16; surrogate splits and overflowing
ranges fail before selection changes. The input owner must supply anchor/focus
direction separately from AppKit caret affinity. Targets are scoped to one view
and exact observed revision. Reusing a stale/cross-view target is an error.

Selections survive updates to other nodes. A change to a selected node explicitly
invalidates its coordinates and collapses the native selection; this conservative
behavior remains a gap against the full parent's stable-anchor preservation
criteria. The current Session read contains only node ID/kind/plain text and has
no rich patch or anchor API. Completing DSK-1.4 requires those ports from the same
shared Session, followed by rich/attachment and anchor integration. Creating a
second NativeEngine for the view would violate model ownership. Unsupported node
kinds fail before storage changes. All delivery capability claims remain
unqualified and native editing stays disabled.
