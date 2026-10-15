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

DSK-1.10-P1 adds revision/tuple-scoped cell targets, guarded portable TableCell
requests, Tab/Shift-Tab traversal (including spanned cells), accessible press-to-focus
and shared undo/redo routing. Native edits are intercepted before storage changes;
formatting cannot bypass the shared planner. NativeSession currently disables
tableCell and exposes no table-policy activation, so cells remain read-only.
The existing shared route supports simple v1 cells only; v2 editing and row/column
actions await the shared owner. Navigation does not imply edit qualification. They have no native undo
stack or independent document/session. Disposing/removing the owner detaches
its controls. Accessibility qualification remains with DSK-1.17 and roadmap 20.

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

`bash native/macos/scripts/check.sh table-editing` currently runs eleven prerequisite
cases against actual AppKit/generated Swift/SQLite snapshots and shared policy
rejection, plus immutable shared producer patches and one explicitly prepared selection-clamping case. It does not close DSK-1.10:
successful native cell commits, structure commands and end-to-end remote/history
qualification await the shared table boundary. The receipt labels this scope;
no synthetic success or skipped acceptance case substitutes for those criteria.
