# Native command admission

`NativeEditorView.commands` routes native menu/context, key, toolbar/Touch Bar
and host actions through the view's serialized shared Session. NSTextView native
history stays disabled. `history` contains actual Rust undo/redo group counts;
empty stacks are disabled separately from read-only and busy states. Snapshots,
permission updates and shared-history results publish current catalog/history
observations before control callbacks. Activation always rechecks Rust permission,
revision and applicability. No second document, command catalog or history exists.

The owned text responder exposes an `UndoManager` forwarding facade for AppKit
enablement and undo/redo actions. It reads the same focused command availability,
rechecks admission on activation, and disables native action registration. It
does not override the containing view's undo manager, so nested host text controls
retain their native history. This AppKit integration does not qualify Safari's
browser Edit menu, which needs its own observed native-history integration.

## Portable structural and formatting actions

`catalog` and `profileAvailability(id)` expose detached shared route/profile
records. `canPrepare` describes admission only. `check(commandsJSON:profile:)`
runs the real Rust target planner without retaining a plan or mutating content.
`perform(commandsJSON:profile:revision:)` accepts the existing `EditorCommand[]`
wire format, including this Session's anchor tokens; it prepares and commits on
one FIFO worker operation and refreshes the authoritative projection on failure.
The default profile is `editac.core`; missing, pending or unavailable profiles and
routes reject explicitly. These entry points do not install optional services.

Native bold/italic/underline/strike, paragraph, left alignment, Enter and split actions
use that same planner. `availability` can return `checking` until asynchronous
exact target validation completes; `validate(action)` lets a menu presenter await
it. Buttons refresh when validation finishes. Validation is scoped to the observed
revision and native selection, bounded, and advisory: commit revalidates. Invalid
ranges and unsupported font/color/other alignment actions cannot mutate AppKit
storage independently. Enter and split capture/release an actual shared anchor and place
the caret in the engine-created block. Native Enter uses the shared list/heading
policy and selection replacement remains a single command intent. Code Return
uses the shared hard-break route. Subsequent collapsed native input uses a single
right-biased shared insert anchor at split boundaries; multi-edit batches retain
the existing sequential UTF-16 coordinate contract. Selection
notifications invalidate button target enablement immediately. Generic structural payloads cover existing
portable list, move and block commands without a native semantic implementation.

Command-Z/Shift-Command-Z and Command-B/I/U route through the same gate. Other
keys retain AppKit handling. `makeButton` supplies native toolbar/Touch Bar controls.
The focused editor alone handles commands; host/query/nested inputs retain their
responder actions. Read-only retains navigation, selection, copy and injected Find.
The trusted host `setPermission` publishes fresh enablement before completion.

## Injected services and transfer dispatch

Set `find` to present the host's native query UI; absence reports `unavailablePort`.
The query field then owns its own text/commands. Shared optional document/code
profiles still report their actual pending service limitations, even with a local
Find presenter; this hook does not qualify those full profiles.

Set `transfer` to dispatch native cut/paste/plain-paste to the transfer owner. It
receives the initiating command and captured revision-scoped selection and returns
portable command JSON synchronously. The adapter uses that captured revision,
then the common prepare/commit gate; no current-caret fallback or direct native
cut/paste mutation is possible. Absence is explicit. This dispatch seam does not
implement delayed providers, rich/literal codecs, OS clipboard lifetime, cross-app
moves or native copy serialization: those remain DSK-1.13/NAT-10/NAT-11. Hosts must
not retain this synchronous context for asynchronous delivery; use the transfer
owner's stable-anchor/cancellation protocol for delayed work.

For a deterministic host Service, `captureService(range:)` captures shared anchors
before work. `completeService(_:text:)` consumes the captured target once;
`cancelService` cancels it. Caret/focus changes do not redirect completion. Shared
input/Rust gates reject stale text, permission loss, foreign/reused tokens and
disposal. Prepared plain-text replacement is qualified; formatted Services and
actual OS Services invocation remain explicit platform qualification work.

## Evidence scope

The canonical `commands` suite executes real AppKit/generated Swift/Rust/SQLite
fixtures with prepared transfer/service ports. See the separate full-command
delivery receipt for exact counts, hashes and host provenance. No provider call,
publication, actual OS Services/physical keyboard observation or platform-support
claim follows from these deterministic protocol tests. Roadmap 20 owns those
physical or virtual platform/IME/accessibility qualification runs.
