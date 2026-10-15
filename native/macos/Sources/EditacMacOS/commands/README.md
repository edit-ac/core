# Native command admission

`NativeEditorView.commands` admits focused responder actions against the view's
current shared Session capability and revision. Menus, command-Z/shift-command-Z,
and host toolbar/touch actions call the same `perform` entry. History calls the
Session undo/redo methods and reads its current projection; NSTextView's native
history stays disabled. Input/composition cannot start during pending history.
Read-only state retains select-all, copy and an injected Find presenter.
`makeButton` supplies native toolbar/Touch Bar controls. Their enablement follows
Session updates and focus; activation always rechecks admission. Use the trusted
host `setPermission` entry to publish fresh enabled state before completion.

Inject `find` to present the host's native query UI. When that field is focused,
its responder owns text and commands. No presenter means `unavailablePort`.
The adapter does not remap OS-reserved shortcuts or non-command-Z key events.

For a deterministic host Service, call `captureService(range:)` before starting
work. Return its token to `completeService(_:text:)`, or `cancelService` on
cancellation. Completion uses captured shared anchors even if focus/caret moves.
The composition owner and Rust reject stale source, permission loss, reused or
foreign tokens and disposal. This is prepared plain-text replacement; formatted
Services and OS Services invocation are unqualified, and no external provider is
called.

The current shared bridge exposes `canHistory` permission, not individual stack
availability. Empty redo is admitted to the shared service and cannot repeat an
edit. Native menus cannot yet report exact empty undo/redo stack enablement.
The bridge also lacks the shared command catalog/structural prepare boundary.
`structural` is explicitly unavailable; it is not a native implementation of
engine operations. Cut/paste await the transfer owner (DSK-1.13), and remain
explicitly unavailable here. These gaps leave DSK-1.7 open. The canonical
`commands` suite proves only the implemented subset, not full SDK qualification.

Roadmap 20 retains actual keyboard/layout, OS Services, accessibility and platform
qualification. Record the package/runtime versions and physical/virtual provenance;
exercise host query input, two editors, menu/context/touch/key actions, permission
loss, stale Service completion and empty-history enablement once its shared port
is connected. Native API calls in the deterministic suite are synthetic protocol
observations, not physical keyboard or OS service observations.
