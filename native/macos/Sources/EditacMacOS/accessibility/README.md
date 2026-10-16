# Native accessible text

`NativeEditorView.accessibility.label` optionally supplies a host label. Without
one the existing session/projection status label remains visible. NSTextView
provides the actual text-area role, value, attributed ranges, selected ranges,
line information, visible range, screen geometry and first-responder focus.
Help distinguishes unavailable, editable, read-only, composing and pending input.

Accessibility replacement setters enter the existing native input delegate and
shared revision/prepare/commit barrier. They cannot write native text directly,
overwrite provisional composition, bypass read-only admission or run after
disposal. Invalid, overflowing and surrogate-splitting ranges fail closed.
Multi-range selection is explicitly unavailable. Selection and copy remain
available in read-only mode. Accessible command actions reuse the same command
catalog/history/focus checks as menu and key actions, including rechecking an
already-retained action at invocation. Asynchronous action success means dispatch
was accepted; the normal command/input result and durable status report commit.
Transfer and optional service availability remains with the relevant owners.

Queries read only the current AppKit projection on MainActor, without synchronous
FFI calls, Session locks, a second model or document scanning to validate a range.
TextKit owns geometry, scrolling and magnification. Native value/selection change
notifications accompany updates. Hosts may use NSScrollView magnification; the
named suite checks 100%, 150% and 200% plus current geometry after edits/scroll.
NAT-14 exercises real nested NSTextStorage editing while an asynchronous actual
Session commit completes, and queries with that Session worker deliberately
blocked. The suite preserves native trace lines for each boundary.

Run `bash native/macos/scripts/check.sh accessibility-text` with the pinned Node
on PATH. These are programmatic AppKit OS-host implementation checks, not actual
VoiceOver, IME, physical-device or platform-support qualification. Roadmap 20
owns the screen-reader run: record OS/build, tool versions, package/source hashes,
VoiceOver version/settings and display/scale; navigate into and out of the editor
by keyboard, read and select mixed Unicode/bidi text, type/delete/undo, repeat in
read-only mode, scroll/magnify, and confirm spoken text/selection/action state
matches the projection without duplicate edits. Preserve failures and unsupported
routes, label physical versus virtual runtime, and leave qualification unchecked
until that run passes.


DSK-1.17 adds native AX tables with indexed rows/columns, cell span ranges,
column-header relationships and the original text controls as cell children.
Surviving coordinates retain AX identity. Removed/disposed elements detach and
cannot focus stale controls. Image/reference groups use shared alt/label data;
atom actions wrap the existing enabled native buttons and recheck admission.
Unknown atoms and math retain source labels without claiming typesetting.

Control-Command-Right/Left moves through cells and attachment/extension selection
buttons in document order, returning to text at either end. The text accessibility
actions expose the same Next structure, Previous structure and Return to editor
routes; native cell Press focuses the actual text control. Read-only navigation
remains available. Focus/status announcements coalesce once per main queue turn,
truncate to 256 characters, suppress duplicates and stop on disposal.

`bash native/macos/scripts/check.sh accessibility-structure` mounts a combined
actual Rust/SQLite corpus in real AppKit windows. It checks structure, spans,
shared labels/actions, keyboard and AX focus, permission changes, actual shared
row removal, resync identity, teardown and bounded announcements. It qualifies
programmatic OS-host implementation only. Roadmap 20 must verify VoiceOver speech,
rotor navigation and platform settings with recorded physical/virtual provenance.

Cell accessibility actions expose bounded unmerged row/column insertion/deletion
through the existing shared table command gate. Read-only/unsupported routes are
omitted; retained actions reject changed captured tuples or revisions. Generic
text-service ranges apply only to main-text focus; atoms use their owned anchors.
