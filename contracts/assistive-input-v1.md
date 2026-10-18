# Portable assistive input v1

AIN-1.1 defines an optional host service alongside the existing AI host-service boundary. Rust `editac_core::extensions::assistive_input` and public `@edit-ac/core/extensions` expose the same descriptor and fixed compatibility corpus at `fixtures/extensions/assistive-input/contract-v1.json`. It is not a data module: no schema registration, new CRDT root, input listener, provider, recognition implementation or history is installed. No import or registration starts a transport. Absent/disabled/disposed registration preserves baseline engine editing and shared undo/redo.

Descriptor `version: 1` names `commands`, `status` and/or `host-transport`. Unknown or duplicate capabilities and incompatible versions reject before registration changes. Transport metadata is required exactly when `host-transport` is declared; otherwise it is explicitly null. It declares audio versus transcript input, on-device/remote/unknown locality, host permission ownership, retention, cancellation behavior and stop availability. Unknown locality remains unknown; OS input does not infer transport availability or locality. These declarations convey no permission or recognition-quality evidence.

All limits are positive integers. Maximums are 16,384 UTF-8 bytes for provisional/final/recovery text, 512 UTF-8 bytes for status/labels, 64 command entries, 1,024 result sequences, eight concurrent sessions and 120,000 milliseconds per session. Hosts may choose smaller limits. A result sequence is zero-based and below the declared results bound; a generation is 1–4,294,967,295. Session and command identifiers are 1–128 ASCII letters/digits/underscore/colon/hyphen. Commands reference existing semantic command identities; this contract does not dispatch them. Disabled command entries require a typed reason; enabled entries have null reason. Nullable fields are explicit null on the wire. Unknown fields reject. TypeScript admission copies inert JSON through the existing bounded module-data validator before accessing fields and freezes returned snapshots.

Registration owns only the immutable descriptor and its cancellation signal. Failed/duplicate registration preserves the accepted descriptor. Disposal clears capability admission and cancels once, including on Rust drop. A retained descriptor is metadata, never an authorization token. Hosts own session IDs/generations, captured engine anchors and document/epoch identity, command applicability, permission decisions, transport handles, timers, callback sequencing and release. The local target uses existing engine anchors, never serializes document context into the transport start request, and grants no edit authority. Transport start carries only version and session identity. The injected host receives the cancellation signal; stop requests a final result, cancel rejects further results, and dispose releases resources. No implicit microphone, provider or credential discovery exists.

Status states are idle, starting, active, preparing, completed, cancelled, stale and failed. Provisional text is separate bounded presenter memory; announcements use the message field and exclude transcripts by default. Accepted final text must pass the existing engine prepare/validate/commit and history boundary. Registration and envelope validation cannot edit a document. This descriptor layer checks shape/bounds only: AIN-1.3 owns state transitions, deadline/session quota enforcement, generation binding, sequence ordering/deduplication, anchor resolution, mutually exclusive OS/transport acceptance and terminal cleanup. AIN-1.2 owns actual accessible controls. Neither dependent gate is qualified by this protocol suite.

The shared Rust conformance harness and TypeScript public-import suite consume hand-authored valid/invalid fixtures. Rust checks real production Document checkpoints, revision, stable anchors, patch/update notifications and shared history around admission/status/results/disposal. Baseline edit/undo/redo uses real engine commands. These are deterministic protocol/engine observations on the local host, not browser/native dictation, device, microphone, screen-reader or provider qualification.

AIN-1.3 portable lifecycle uses `AssistiveInputSession` and `captureAssistiveTarget`.
A session accepts one final result and then terminates. Provisional/result sequences
are strictly increasing within a unique instance ID and generation; gaps are
allowed, duplicates and prior identities are inert. One active session per instance
and the descriptor's registration-wide concurrent-session limit are enforced.
The deadline spans start through final completion; stop requests completion but
does not reset the deadline. All terminal states abort acceptance before cancelling
and disposing the host handle and releasing copied engine anchors. Synchronous
callbacks from start and cleanup use the same guards as asynchronous callbacks.

Web hosts opt in with `assistiveInput(registration, {host:{transport, commit,
allowed}})`. The commit callback must call the captured editor's existing Session
storage commit port; `allowed` mirrors host replacement permission and is rechecked
at acceptance. The editor captures stable engine anchors locally, rechecks document
identity/epoch and target existence, and executes the existing prepared replacement
and selection/history commands with origin `assistive:final`. An independent remote
edit rebases anchors; deletion of the selected range or its owner becomes stale.
The portable target admits stable text-block ranges, including directional ranges
across blocks; unsupported owners are rejected without mutation. Changing the live caret never redirects that range.
A committed result stays consumed when a subsequent persistence/presentation callback
fails. Provisional/status messages create no document updates or undo entries.

OS beforeinput/input/composition retains its existing owner. Any such input revokes
the optional transport before reconciliation, including missing/noncancelable
beforeinput sequences. Leaving the editor/assistance focus boundary, closing the
panel, window blur or hiding the document cancels; internal control focus retains
the session. Keyboard start moves focus to enabled Stop/Cancel while pending.
Read-only invalidates; editor/registration
teardown disposes. Start/stop/cancel/recovery are ordinary named controls. Recovery
returns bounded unaccepted text only on explicit user request; reset clears it,
and no recovery automatically inserts into a new target. Unknown processing locality
is displayed as unknown; audio/transcript processing, permission and retention are
host-declared. No microphone, document context, raw transcript metadata, provider,
credential lookup or network fallback is introduced.

Only explicitly active transport sessions display bounded uncommitted preview text;
standalone status updates keep provisional text private. Preview text is outside
status announcements. Explicit recovery displays unaccepted text without inserting it.
Hosts must deliver each recognition result through one route, never mirror it into
both OS input and the optional transport. OS input revokes any active transport;
subsequent ordinary OS edits after a terminal result remain baseline input.

Cross-block text replacement delegates to the existing bounded plain-fragment
replacement command, including its result caret and history bookmarks. Single-block
replacement uses the existing editor commands. Starting an already active instance
releases the new target without starting host work; cancel explicitly before restart.
