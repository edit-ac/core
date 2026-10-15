# Committed AppKit input

`NativeCommittedInput` intercepts NSTextView's single-range text-system proposal.
The native control does not mutate first: the captured UTF-16 target and revision
enter one serialized Session prepare/commit/read operation. Only its authoritative
rich projection changes storage. A successful edit places the caret at the shared
accepted replacement boundary. AppKit's independent undo stack is disabled.

Admission is disabled while an edit is pending. Rejected commands reread the same
Session, so a stale projection refreshes without retaining rejected native text.
Read-only state follows `canApply`; disposal clears input callbacks. Projection
application cannot become native input. Errors remain explicit through `lastFailure`
and `onResult`; the host supplies the clock domain used by permission leases.

The `edits` dispatcher runs actual AppKit/generated-Swift/Rust/SQLite cases.
Composition/OS replacements belong to DSK-1.6; multi-range and cross-block
structural edits reject explicitly until their owning shared command routes are
wired. Rich transfer, command routing, platform IME and accessibility qualification
remain separate gates. No provider, network or publication is used.
