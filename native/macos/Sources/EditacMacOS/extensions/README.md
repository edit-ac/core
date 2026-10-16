# Native renderer prerequisite

`NativeEditorView.extensions` owns a per-editor registry of trusted native atom
factories and mark presentation callbacks. Register before opening the Session;
the registry freezes on its first projection. Duplicate registration fails without
replacing the original. This registry selects presentation; it cannot register
schema, reinterpret data versions or grant a mutation capability.

Atom renderers receive owned descriptors and return real AppKit controls. Updates
retain node/view identity. The adapter owns attachment metrics and shared-anchor
selection. Renderer failures dispose the renderer and expose preserved source;
unchanged failed descriptors are not repeatedly retried. Removed nodes and editor
disposal release native views and hooks once. Callbacks run on the main actor after
the Session transaction. Host code must bound its work; exception isolation cannot
preempt an infinite loop. Factories/renderers are host objects, never document data.

Descriptors retain the exact semantic JSON tuple and payload with deterministic
key ordering. Unknown types/versions use a selectable, nonediting NSTextView with
an explicit diagnostic. The adapter never evaluates source or resolves assets.
`editac.math` source (including invalid source) remains visible. Source presentation,
source editing and typesetting are separate booleans; the latter two are currently
false. A registered renderer alone does not qualify math typesetting.

Mark callbacks receive owned JSON and can supply only font/color/decoration keys.
Shared wire attributes, link targets, attachment geometry and paragraph coordinates
cannot be replaced. Throwing callbacks leave source metadata intact. Prepared mark
presentation tests do not qualify actual custom-mark editing.

DSK-1.12 remains open. The native Session's six built-in mark commands and bounded
image/reference atomicContent port do not provide custom-mark registration/editing
or math/inert-atom source replacement. The shared owner must qualify those prepared
edit boundaries before this adapter can add native edit controls and full history,
stale/cancellation/read-only proof. No local semantic store or direct native-text
mutation is substituted for that dependency.

`bash native/macos/scripts/check.sh extensions` builds both pinned CPU slices and
runs 14 actual Rust-checkpoint/SQLite/generated-Swift/Session/AppKit cases plus four
prepared presentation/admission guards. OS IME, VoiceOver, platform support,
clipboard, packaging and release qualification are separate gates.
