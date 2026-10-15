# Native table projection

DSK-1.9 projects the admitted `module:editac.table` v1/v2 tuple into real
AppKit `NSTextView` cells inside a horizontally scrollable native table view.
TextKit attachment metrics reserve the table's actual height in the main text
flow. Layout follows its current shared node range after patches and width
changes. The shared Session remains the sole semantic document.

The table view is keyed by shared node ID. Cell views are keyed by row/column
coordinate within that node: the shared opaque tuple has no independent row or
cell IDs. Content changes retain controls; geometry updates retain surviving
coordinates and remove obsolete controls. This does not infer semantic row
identity through insertions, moves or replacement of the table owner.

Version 1 renders bounded rectangular inline cells. Version 2 additionally
renders spans, covered positions, headers and ordered paragraph/heading/code
blocks. Both use the existing native style registry for Unicode, marks and
links. Exact shared tuples remain available on `NativeTableView.sharedTuple`;
source text is never used as the table renderer. Bounds are 128 rows, 32 columns,
1024 paragraphs/runs and 1 MiB source, matching shared admission. The Session
validates semantic content and URLs; the presenter additionally checks geometry
before changing native storage. Unsupported table versions fail projection.

DSK-1.10 connects captured tuple/revision targets to the actual shared command
planner. A trusted host explicitly enables the default-disabled codec through
`view.tables.setPolicy(enabled:)`; permission stays independent. Native v1 and
single-block v2 cells commit through the same command/history gate. The shared
planner retains marks, links, cell metadata and source. Multi-block v2 cells remain
read-only; covered positions have no editable child. Native storage never commits
provisional cell text or creates an independent UndoManager entry. Accepted typing
updates the native caret; rejection retains authoritative projection.

Tab/Shift-Tab traverse real native children, including spans, and leave the table
without inserting rows. Accessible press focuses a cell. `makeStructureButton`
exposes native button actions for the four shared row/column routes. Buttons track
policy, permission and pending state; the shared planner rechecks exact target,
geometry and limits on activation. Spanned v2 structural commands reject explicitly.
Control identity is coordinate-scoped: shared tuples have no row/cell IDs. Surviving
coordinates retain controls and selection through patches; shifting semantic cells
does not invent stable row identities.

The serialized executor exports owned pending journals, reserves remote writer IDs
and accepts peer updates only after an explicit host admission callback. Hosts must
authenticate/authorize and verify/decrypt the negotiated envelope before admission;
writer IDs/checksums are never credentials. The deterministic host tests admit only
exact prepared entries from independent SQLite peers. This bounded journal route
makes no transport, lease, presence, network-crypto or full-collaboration claim.

`bash native/macos/scripts/check.sh table-projection` creates an actual Rust
Session/EditService/SQLite fixture, then runs 14 native XCTest cases through the
pinned generated Swift/AppKit host. Eleven cases use actual shared snapshots
and/or durable incremental patches, including shared history; three explicitly
named prepared cases cover in-place dimension/rich-tuple projection and atomic
unsupported-version rejection. The shared v1 TableCell route produces the
actual content patch. Existing shared APIs cannot replace an existing table
using Content; prepared shape/rich updates do not claim those command routes,
remote transport, OS input or platform qualification. The fixture carries actual
observed revisions and verifies local receipts for each real commit.

`bash native/macos/scripts/check.sh table-editing` runs the canonical native table
suite against real AppKit/generated Swift/Session/SQLite, including successful v1/v2
native edits, all four structural actions and shared local undo/redo across admitted
peer changes. A second actual shared checkpoint supplies unmerged v2 structure.
Prepared projection-only cases remain separately identifiable; they do not replace
journal-ingress proof. Platform/IME/accessibility qualification stays with the
owning later gates. The dispatcher retains both consumed CPU dylibs immutably beside
each receipt before shared build paths can be overwritten.
