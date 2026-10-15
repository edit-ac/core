# macOS native control feasibility

DSK-1.2 selects AppKit `NSTextView` with an explicitly constructed TextKit 1
`NSTextStorage` / `NSLayoutManager` / `NSTextContainer` graph. The production
`NativeEditorView` and internal probe use this same graph. There is no WebView,
TextKit 2 fallback, alternate semantic store or platform table document model.
The production control stays noneditable pending shared-session admission.

Run from `core` with the pinned Node on PATH:

```sh
bash native/macos/scripts/check.sh toolkit
```

The internal `EditacMacOSProbe` target is a deterministic native fixture, not an
SDK product. Six real XCTest cases mount it in AppKit windows on the pinned
macOS OS test host. The dispatcher builds both CPU slices but executes arm64
only, retains commands/input hashes/counts/failures, and rejects missing/zero or
skipped tests. Receipts live in `.artifacts/macos/toolkit-*/`; copied immutable
receipts in the architecture evidence tree are the durable result.

| Route | Selected native hook and fixture proof | Remaining owner / limitation |
| --- | --- | --- |
| Composition | `NSTextInputClient.setMarkedText`, `markedRange`, `selectedRange`, `insertText`, `unmarkText`, attributed-substring query; UTF-16 emoji replacement, Japanese provisional/committed strings and clearing marked text | DSK-1.5/1.6 bind commands, captured cancellation targets, overlap and OS replacements. Protocol calls are deterministic fixture input, not an actual IME session. `unmarkText` alone accepts provisional text; cancellation must restore the captured target. |
| Edit admission | `NSTextViewDelegate.shouldChangeTextIn` rejects a replacement; `textDidChange` observes native edits | DSK-1.3/1.5 serialize shared calls and reconcile rejected projection. No fixture edits count as engine commits. |
| Selection | `setSelectedRange`, `textViewDidChangeSelection`, attachment range and `NSLayoutManager` glyph bounds | DSK-1.4 maps stable engine anchors and selection direction; stale ranges, scrolling, bidi and remote patches remain unqualified. |
| Rich text | Font/link attributes coexist with a real `NSTextAttachment` | DSK-1.8 owns descriptor mapping and semantic equality; native attributes are not an engine schema. |
| Tables | `NSGridView` owns four real `NativeEditorView` cell controls; cell-local insert/composition, independent text, explicit `nextKeyView` focus | Select native child controls rather than `NSTextTable` as an editable semantic model. DSK-1.9/1.10 must map engine cell IDs, bounds, row/column commands, remote patches, selection and undo. Fixed 2×2 fixture has no merged cells, virtualization or nested tables. |
| Atoms | `NSTextAttachment` occupies one UTF-16 code unit; an editable `NSTextField` child overlays its measured glyph rect and edits through the OS field editor | DSK-1.11/1.12 own source commands, lifetime, disposal, unknown data and descriptor hooks. Fixed range/geometry demonstrates feasibility only; production must map IDs and re-layout after patch/scroll/resize. Source editing implies no math typesetting. |

All required candidate routes have concrete tests; a failed route keeps this gate
and its dependents open. The child-control route avoids relying on built-in table
text storage or attachment images as the editing surface. It does not establish
full table/atom parity, accessibility relationships, shared history or platform
support. Native undo remains disabled on editor/cell projections. The temporary
AppKit field editor will also need the shared command/history gate when wired
into production. DSK-1.7 owns that integration.

Pins and deployment declarations remain in `../toolchain.json`. This is OS-host
deterministic feasibility, with no physical keyboard/IME, screen-reader or
performance qualification. Capability states stay unqualified. Roadmap 20 owns
the actual physical or virtual platform runs.
