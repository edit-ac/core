# Native standard style projection

`NativeStyleRegistry` consumes the existing shared run, block and container
descriptors. It maps bold/italic/underline/strike/code/link runs, headings 1–6,
code paragraphs, quotes, and nested unordered/ordered/task lists to native
fonts, colors and `NSParagraphStyle`/`NSTextList` metadata. Checked state and
ordered numbering come from the shared projection. Container-only patches
restyle descendants even when their text does not change. AppKit label/link
colors follow the host appearance; the baseline font is 14pt. Accessibility
scaling and screen-reader qualification remain with their owning gates.

TextKit 1's layout manager draws list markers and quote rules in paragraph
gutters. Markers never become document characters, so shared UTF-16 coordinates,
copy semantics, identities and selections remain unchanged. Native commands
continue to use the shared mutation/history gate. Original wire metadata and
unowned host attributes survive presentation updates. A paragraph with no text
uses native typing attributes; an empty list row retains its shared descriptor.
On the pinned OS, `NSTextView.typingAttributes` strips `textLists` even when the
supplied paragraph style includes it (see the preserved standalone AppKit probe).
The native typing indent and gutter remain; the next accepted native insertion
receives its full list metadata from the shared patch. No automatic AppKit list
editing or injected marker characters are used to work around this behavior.

Run `bash native/macos/scripts/check.sh styles` with the pinned Node toolchain.
The native-owned Rust fixture factory parses the existing portable transfer
schema, builds the corpus through shared fragment commands, asserts semantic
export equality, and writes a real SQLite checkpoint. XCTest opens that store
through generated Swift/Rust Session, compares all projected wire descriptors,
checks native styles/layout, and exercises shared incremental commands/history.
The dispatcher pins the corpus/factory/store/source and both CPU build inputs;
`style-corpus.png` records actual AppKit glyph rendering on the arm64 OS host.
This is deterministic native implementation proof, not actual IME, accessibility,
package, clipboard or platform support qualification. No network/provider is used.
