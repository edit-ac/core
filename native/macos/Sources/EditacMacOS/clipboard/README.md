# Native clipboard transport prerequisite

`NativeClipboardTransport` transports owned bytes through AppKit pasteboards.
It maps the portable fragment and extension MIME identifiers to valid native
UTIs (`ac.editac.fragment-json` and `ac.editac.extension-transfer-json`) alongside
HTML, RTF, Markdown and UTF-8 plain-text types. MIME strings are not native UTIs.
The shared 1 MiB per-flavor bound and UTF-8 checks apply before publishing; at
most six known flavors occupy 6 MiB total. All flavors are staged and read back
before an OS publication acknowledgement is returned. Replacing the pasteboard
invalidates that acknowledgement. Multiple items and unavailable/failed provider
data fail explicitly instead of silently discarding content. Tests use isolated
actual OS pasteboards and release them after each case.

Promised providers own immutable data without retaining an editor or Session.
Keep the returned publication alive for its promised lifetime. Source disposal
does not invalidate those bytes. An acknowledgement is not a durable destination
receipt and cannot authorize source deletion or a cross-document move.

`view.clipboard.begin` captures a target in that view. `NativeClipboardRead`
collects actual `NSItemProvider` representations, retaining rich and literal
flavors for the future shared import boundary. Literal mode requests only plain
text. Delivery is single-use and checks permission, revision, composition/busy
state and disposal again. View disposal cancels reads; late callbacks are inert.
Focus or selection changes never retarget a pending delivery to another editor.
This prerequisite uses strict revision-scoped rejection; shared retained-anchor
mapping and mutation revalidation remain required by the full transfer gate.

These APIs expose untrusted bytes, not admitted engine fragments. They do not
parse/sanitize rich formats, fetch assets, mutate documents, delete a cut source,
or implement menu/drop semantic routing. The current generated Swift Session
has no fragment export/prepared transfer API. The shared-owner request is
`DSK-1.13-shared-transfer-boundary-20261016.json` in the coordination requests.
After that qualified return, DSK-1.13-P3 must wire shared codecs and prepared
transfers into the existing command gate, including actual same-session views,
history/receipts, rich hostile/fallback corpus and cross-app move policy.

Run `bash native/macos/scripts/check.sh clipboard-transport` for this prerequisite.
It is not the original canonical `clipboard` suite, NCL installed-package host
qualification, an actual external-app transfer, or platform/release support.
