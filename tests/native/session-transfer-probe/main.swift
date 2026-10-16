import Foundation
struct Failure: Error { let message: String }
func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw Failure(message: message) }
}
func reject(_ operation: () throws -> Void) throws {
    do { try operation() } catch is NativeSessionError { return }
    throw Failure(message: "expected native rejection")
}
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
func fixture(_ n: Int, _ text: String) throws -> (NativeSessionOptions, NativeSession) {
    let options = NativeSessionOptions(path: root.appendingPathComponent("transfer-\(n).sqlite").path,
        documentId: String(format: "e7100000-0000-4000-8000-%012x", n), epoch: "e7200000-0000-4000-8000-000000000001", writable: true, permissionExpiresAt: nil)
    return (options, try NativeSession.createLocal(options: options, initial: [NativeSessionSeed(kind: "block", text: text)]))
}
func revision(_ s: NativeSession) throws -> Data { try s.read(now: 0).revision! }
func text(_ s: NativeSession) throws -> String { try s.read(now: 0).nodes.filter { $0.kind == "block" }.map { $0.text }.joined(separator: "\n") }
func range(_ s: NativeSession, _ from: UInt32, _ to: UInt32) throws -> NativeTransferRange {
    let read = try s.read(now: 0), node = read.nodes.first { $0.kind == "block" }!.id
    let anchors = try s.captureAnchors(revision: read.revision!, inputs: [AnchorInput(node: node, offsetUtf16: from, bias: .left), AnchorInput(node: node, offsetUtf16: to, bias: .right)])
    return NativeTransferRange(anchor: anchors[0].token, focus: anchors[1].token)
}
func plain(_ text: String) -> NativeTransferInput { NativeTransferInput(fragmentJson: nil, markdown: nil, html: nil, plainText: text, literal: false) }
var passed = 0
// Exact generated owned range/paste and SQLite reopen, one durable history unit.
do {
    let (options, s) = try fixture(1, "A🦀B")
    let export = try s.exportTransfer(revision: revision(s), range: range(s, 1, 3), now: 0)
    try require(export.plainText == "🦀", "UTF16 export")
    let p = try s.preparePaste(revision: revision(s), range: range(s, 1, 3), input: plain("hello"), source: nil, now: 0)
    let committed = try s.commitTransfer(token: p.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0)
    try require(committed.commit?.durability == .processCrash, "durable receipt")
    try require(text(s) == "AhelloB", "paste")
    try require(s.historyState(now: 0).undoGroups == 1, "one history")
    _ = try s.undo(revision: revision(s), now: 0); try require(text(s) == "A🦀B", "undo")
    _ = try s.redo(revision: revision(s), now: 0); try s.dispose()
    let opened = try NativeSession.open(options: options); try require(text(opened) == "AhelloB", "reopen"); try opened.dispose(); passed += 1
}
// Cut cannot bypass acknowledgement, failed admission consumes token.
do {
    let (_, s) = try fixture(2, "hello")
    let p = try s.prepareCut(revision: revision(s), range: range(s, 1, 4), now: 0)
    try reject { _ = try s.commitEdits(token: p.token, now: 0) }
    try reject { _ = try s.commitTransfer(token: p.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0) }
    try reject { _ = try s.commitTransfer(token: p.token, clipboardAcknowledged: true, destinationReceipt: nil, now: 0) }
    try require(text(s) == "hello", "unacknowledged cut changed source")
    let cut = try s.prepareCut(revision: revision(s), range: range(s, 1, 4), now: 0)
    _ = try s.commitTransfer(token: cut.token, clipboardAcknowledged: true, destinationReceipt: nil, now: 0)
    try require(text(s) == "ho", "cut"); try s.dispose(); passed += 1
}
// Same-session move is one atomic Session history action.
do {
    let (_, s) = try fixture(3, "abcdef")
    let p = try s.prepareTransferMove(revision: revision(s), source: range(s, 1, 3), destination: range(s, 6, 6), now: 0)
    _ = try s.commitTransfer(token: p.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0)
    try require(text(s) == "adefbc", "move"); try require(s.historyState(now: 0).undoGroups == 1, "move history")
    _ = try s.undo(revision: revision(s), now: 0); try require(text(s) == "abcdef", "move undo"); try s.dispose(); passed += 1
}
// Opaque provenance allows explicit cross-document source deletion only after durable paste.
do {
    let (_, s) = try fixture(4, "source"), (_, d) = try fixture(5, "")
    let cut = try s.prepareCut(revision: revision(s), range: range(s, 0, 6), now: 0), e = cut.exported!
    let input = NativeTransferInput(fragmentJson: e.fragmentJson, markdown: e.markdown, html: nil, plainText: e.plainText, literal: false)
    let paste = try d.preparePaste(revision: revision(d), range: range(d, 0, 0), input: input, source: e.source, now: 0)
    let receipt = try d.commitTransfer(token: paste.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0).destinationReceipt!
    try require(text(s) == "source", "copy default")
    _ = try s.commitTransfer(token: cut.token, clipboardAcknowledged: false, destinationReceipt: receipt, now: 0)
    try require(text(s) == "" && text(d) == "source", "qualified source delete"); try s.dispose(); try d.dispose(); passed += 1
}
// Ownership/cancel/permission and unsupported source diagnostics survive generated transport.
do {
    let (_, s) = try fixture(6, "")
    let p = try s.preparePaste(revision: revision(s), range: range(s, 0, 0), input: NativeTransferInput(fragmentJson: nil, markdown: nil, html: "<img src='https://attack.invalid/x'>", plainText: "safe", literal: false), source: nil, now: 0)
    try require(p.diagnostics == ["html-img-requires-extension-codec"] && p.source?.html == "<img src='https://attack.invalid/x'>", "source recovery")
    try s.setPermission(writable: false, expiresAt: nil)
    try reject { _ = try s.commitTransfer(token: p.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0) }
    try require(text(s) == "", "permission")
    try s.setPermission(writable: true, expiresAt: nil)
    let cancelled = try s.preparePaste(revision: revision(s), range: range(s, 0, 0), input: plain("discard"), source: nil, now: 0)
    try s.cancelTransfer(token: cancelled.token)
    try reject { _ = try s.commitTransfer(token: cancelled.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0) }
    try s.dispose(); passed += 1
}
// Shared sanitized rich HTML survives generated transport, one history and SQLite reopen.
do {
    let (options, s) = try fixture(7, "")
    let raw = "<h2><b>é😀</b></h2><ol start='3'><li><i>one</i></li></ol><pre> x\n y</pre>"
    let p = try s.preparePaste(revision: revision(s), range: range(s, 0, 0), input: NativeTransferInput(fragmentJson: nil, markdown: nil, html: raw, plainText: "wrong", literal: false), source: nil, now: 0)
    try require(p.diagnostics.isEmpty && p.source?.html == raw, "rich HTML recovery")
    try require(text(s) == "", "HTML preparation mutated")
    _ = try s.commitTransfer(token: p.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0)
    let saved = try text(s)
    try require(saved.contains("é😀") && !saved.contains("wrong"), "HTML precedence")
    try require(s.historyState(now: 0).undoGroups == 1, "HTML history")
    _ = try s.undo(revision: revision(s), now: 0); try require(text(s) == "", "HTML undo")
    _ = try s.redo(revision: revision(s), now: 0); try s.dispose()
    let reopened = try NativeSession.open(options: options); try require(text(reopened) == saved, "HTML SQLite reopen"); try reopened.dispose(); passed += 1
}
// Sanitization keeps exact source while dropping script, attributes and unsafe URLs.
do {
    let (_, s) = try fixture(8, "")
    let raw = "<script>bad</script><p onclick='bad'><a href='java&#115;cript:bad'>safe</a></p>"
    let p = try s.preparePaste(revision: revision(s), range: range(s, 0, 0), input: NativeTransferInput(fragmentJson: nil, markdown: nil, html: raw, plainText: nil, literal: false), source: nil, now: 0)
    try require(p.diagnostics.contains("html-url-dropped") && p.diagnostics.contains("html-executable-dropped") && p.source?.html == raw, "HTML diagnostics")
    _ = try s.commitTransfer(token: p.token, clipboardAcknowledged: false, destinationReceipt: nil, now: 0)
    try require(text(s) == "safe", "sanitized HTML"); try s.dispose(); passed += 1
}
// Unsupported resources and bounded malformed input never mutate SQLite/history.
do {
    let (_, s) = try fixture(9, "keep")
    for raw in ["<table><tr><td>x</td></tr></table>", String(repeating: "<div>", count: 34) + "x" + String(repeating: "</div>", count: 34)] {
        try reject { _ = try s.preparePaste(revision: revision(s), range: range(s, 0, 4), input: NativeTransferInput(fragmentJson: nil, markdown: nil, html: raw, plainText: nil, literal: false), source: nil, now: 0) }
    }
    try require(text(s) == "keep" && s.historyState(now: 0).undoGroups == 0, "HTML rejection atomicity"); try s.dispose(); passed += 1
}
print("{\"executed\":8,\"passed\":\(passed),\"failed\":0,\"skipped\":0}")
