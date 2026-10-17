# Integrated command history fixture

INT-1.12 HIS-01–05 runs the production `mountEditorSurface`, current packed WASM
engine, recovered Session and IndexedDB journal. Markdown and slash commands use
the production adapters. Peer changes come from a second real Yrs replica. The
second mounted editor has its own recovered document, Session and journal.

Keyboard/pointer activation is driven by Playwright. Clipboard payloads and
composition event sequences are authored deterministic traces; they do not prove
OS clipboard, IME, accessibility or device support. Literal multiline paste keeps
its newline inside the block. Undo of a slash fragment selects the restored query
range, as required by the existing semantic replacement policy.

Host menu/toolbar controls capture `surface.captureHistory()` while the editor
owns selection, call `target.execute('undo' | 'redo')`, and dispose on activation or
dismissal. The target delegates to the keyboard history path. Revision changes,
permission loss, disposal, and focus entering another editor/native text control
reject the captured history intent. Captured formatting similarly rejects focus
moving to another editor while permitting its own property inputs.

The suite independently checks content, directional selection, emitted updates,
durable journal entries, grouping, remote preservation, late async cancellation,
malformed-batch atomicity and listener/target teardown. Retained failures belong
in the architecture evidence directory, never in the source roadmap.
