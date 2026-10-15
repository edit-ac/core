# Composition ownership and qualification handoff

DSK-1.6 implements NSTextInputClient on the existing TextKit 1 NSTextView.
Rust remains the sole committed model. Marked updates write only temporary
native storage. Independent shared anchors are captured before the first update.
Final input consumes its target, resolves and validates selected source on the
serialized Session worker, then prepares, commits and reads one operation.
Empty/unchanged finalization, cancellation, read-only and disposal cannot admit
provisional text. TextKit still supplies surrounding text and geometry.

`captureReplacement(range:)` is the host integration point for asynchronous
text-checking, autocorrect and dictation. Capture before work, return the opaque
token to `replace(_:with:)`, and call `cancelReplacement` on cancellation. Never
use the current caret at completion. Tokens cannot cross views or be reused.
Synchronous native `insertText(_:replacementRange:)` uses the committed-input
route. No external service, AI provider or credentials are invoked.

Deterministic fixtures call native protocol APIs on the pinned macOS OS host,
using generated Swift, real Rust Session and SQLite. Concurrent changes are committed by a second actual Session writer in SQLite,
then replayed into the existing view owner through shared recovery. This proves
local delivery and anchor/history behavior, not network transport. Actual
Transport/reconnect belongs to DSK-1.15.
Synthetic protocol calls do not qualify OS IMEs, dictation engines or keyboards.

## Roadmap 20 OS/IME runbook (unqualified until executed)

1. Record immutable package/source hashes, macOS build, CPU, physical/virtual
   provenance, Xcode/Swift/SDK, keyboard layout and IME names/versions. Use the
   installed consumer offline, with no account, credentials or paid service.
2. Run Japanese/Korean/Chinese composition at a caret and forward/reverse range
   in `A🦀éאבB`. Observe native candidates and marked/selected UTF-16 ranges.
   Intermediate changes must create no shared history or journal entry.
3. Commit through candidates/Enter, cancel with Escape and change focus. Check
   text/selection, one shared undo operation for commit and none for cancellation.
   Preserve actual callback order, including unmark/insert order and repeated
   callbacks. Test an independently authored identical subsequent edit.
4. Capture `teh` in `teh cat`, move the caret, then complete a prepared replacement.
   Check the captured source changes; cancelled/foreign/stale results reject.
   Repeat with supported local OS autocorrect/dictation. Report unavailable
   services explicitly rather than substituting a live provider.
5. Deliver another fixture's committed update outside, overlapping and deleting
   the captured source. Outside changes remap; changed/deleted source rejects
   without removing concurrent content. Revoke permission/dispose during input.
6. Record executed/passed/failed/skipped counts and preserve all failures. Supply
   tested virtual equivalents under verification.md for unavailable hardware.
   Roadmap 20 owns platform qualification; this handoff cannot claim support.

Preliminary observations: no actual OS IME/dictation observations collected.
Runtime results and immutable provenance live in the composition delivery receipt.
All platform, actual IME and release claims remain unqualified. No publication.
