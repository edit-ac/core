# Native extension presentation and editing

`NativeEditorView.extensions` owns trusted native atom factories and mark
presenters. Register before opening; the native registry freezes on its first
projection. Pass the portable data-only definitions separately as `registryJSON`
to `session.open`. The shared Session validates and freezes those definitions
before opening or creating SQLite. Native callbacks grant no schema or policy.

Call `extensions.setPolicy(enabled: true)` to opt into the shared prepared edit
ports. The default is disabled. `makeMarkButton` supplies a native formatting
action for the current selection; `applyMark` accepts an explicitly captured
revision-scoped selection. Values use the portable `[version, attributes]` JSON
envelope, or nil for removal. Registered presenters supply display attributes
only; shared metadata, geometry, links and coordinates cannot be overwritten.

Inert atom views expose Edit source, Save and Cancel controls. An edit captures
one shared source-owned anchor, the exact tuple and revision. Save uses the shared
`extensionSource` command through the ordinary command gate, durability and
history. Targets are single use, cancelled on changed revision and released on
cancel/disposal. Current permissions and extension policy are rechecked by the
Session. Source is bounded to 8192 UTF-16 units. Unknown type/version/payload and
invalid math source survive unchanged apart from the explicitly edited source.
Unknown executable behavior never runs. Unsupported non-inert tuples remain
read-only. Source drafts are temporary native UI state, never another replica.

Native renderers receive owned descriptors. Stable nodes retain native view
identity; updates, removal and disposal release resources once. Renderer failure
exposes preserved source. Callbacks run on the main actor after the transaction;
hosts must bound work. No network, source evaluation or asset resolution occurs.
Math preserves and edits source; typesetting remains unavailable and separately
reported. A registered renderer alone does not qualify math typesetting.

The canonical `bash native/macos/scripts/check.sh extensions` builds pinned arm64
and x86_64 slices and runs actual Rust/SQLite/generated-Swift/AppKit cases plus
separately labeled prepared presentation guards. Platform/IME/VoiceOver,
clipboard, packaging and release qualification remain separate gates.
