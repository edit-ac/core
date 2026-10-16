import Foundation

struct Failure: Error { let message: String }
func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw Failure(message: message) }
}
func expect(_ reason: (NativeSessionError) -> Bool, _ operation: () throws -> Void) throws {
    do { try operation() } catch let error as NativeSessionError {
        try require(reason(error), "wrong typed error: \(error)"); return
    }
    throw Failure(message: "expected typed rejection")
}
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let limit: UInt64 = 16 * 1024 * 1024
func fixture(_ n: Int) throws -> (NativeSessionOptions, NativeSession) {
    let options = NativeSessionOptions(path: root.appendingPathComponent("review-\(n).sqlite").path,
        documentId: String(format: "e9100000-0000-4000-8000-%012x", n), epoch: "e9200000-0000-4000-8000-000000000001",
        writable: true, permissionExpiresAt: nil)
    return (options, try NativeSession.createLocal(options: options, initial: [NativeSessionSeed(kind: "block", text: "A🦀B")]))
}
func capture(_ s: NativeSession, _ name: String, key: String? = nil) throws -> NativeReviewRevision {
    try s.captureReviewRevision(revision: s.read(now: 0).revision!, name: name, requiredKeyProfile: key)
}
func bytes(_ s: NativeSession, _ r: NativeReviewRevision, key: String? = nil) throws -> Data {
    guard case let .available(_, value) = try s.readReviewRevision(revision: r, availableKeyProfile: key) else { throw Failure(message: "unavailable read") }
    return value
}
func compare(_ s: NativeSession, _ a: NativeReviewRevision, _ b: NativeReviewRevision) throws -> NativeChangeModel {
    guard case let .available(model) = try s.compareReviewRevisions(before: a, after: b, beforeKeyProfile: nil, afterKeyProfile: nil, maxBytes: limit) else { throw Failure(message: "unavailable comparison") }
    return model
}
func edit(_ s: NativeSession, _ text: String) throws -> NativeSessionCommit {
    let live = try s.read(now: 0)
    let plan = try s.prepareEdits(revision: live.revision!, edits: [NativeSessionEdit(node: live.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: text)], origin: "untrusted-host-label", now: 0)
    return try s.commitEdits(token: plan, now: 0)!
}
var results: [[String: Any]] = []
func run(_ name: String, _ body: () throws -> Void) {
    do { try body(); results.append(["id": name, "passed": true]) }
    catch { results.append(["id": name, "passed": false, "error": String(describing: error)]) }
}
run("actual-sqlite-immutable-comparison-and-reopen") {
    let (options, s) = try fixture(1); defer { try? s.dispose() }
    let before = try capture(s, "not-an-author")
    try require(before.documentId == options.documentId && before.epoch == options.epoch, "scope binding")
    try require(before.hash.count == 32 && before.observedRevision.count == 65 && before.representation == .semantic, "identity encoding")
    let owned = try bytes(s, before)
    let receipt = try edit(s, "xy")
    try require(receipt.sequence == 1 && receipt.checksum.count == 32, "durable receipt")
    let after = try capture(s, "after")
    let history = try s.historyState(now: 0)
    let checkpoint = try s.recoveryExport().checkpoint.bytes
    let pending = try s.pendingUpdates()
    let wire = try compare(s, before, after)
    try require(wire.attribution == "unknown" && wire.representation == .semantic, "no inferred authorship")
    try require(s.validateChangeModel(bytes: wire.json, maxBytes: limit).json == wire.json, "canonical model")
    try require(s.historyState(now: 0) == history, "history unchanged")
    try require(s.recoveryExport().checkpoint.bytes == checkpoint, "live checkpoint unchanged")
    try require(s.pendingUpdates() == pending, "journal unchanged")
    try require(s.read(now: 0).nodes[0].text == "AxyB", "live replica unchanged")
    try require(bytes(s, before) == owned, "immutable old bytes")
    try s.dispose()
    let reopened = try NativeSession.open(options: options); defer { try? reopened.dispose() }
    try require(reopened.read(now: 0).nodes[0].text == "AxyB", "SQLite reopen")
    guard case .unavailable(.missing) = try reopened.readReviewRevision(revision: before, availableKeyProfile: nil) else { throw Failure(message: "process-local history leaked") }
    try require(!owned.isEmpty, "owned data survives disposal")
}
run("unavailable-states-key-generation-and-fifo") {
    let (_, s) = try fixture(2); defer { try? s.dispose() }
    let locked = try capture(s, "locked", key: "key-v1")
    guard case .unavailable(.keyUnavailable) = try s.readReviewRevision(revision: locked, availableKeyProfile: "key-v2") else { throw Failure(message: "rotated key") }
    try require(!bytes(s, locked, key: "key-v1").isEmpty, "matching key profile")
    let open = try capture(s, "open")
    guard case .unavailable(.after, .keyUnavailable) = try s.compareReviewRevisions(before: open, after: locked, beforeKeyProfile: nil, afterKeyProfile: nil, maxBytes: limit) else { throw Failure(message: "comparison side") }
    var future = open; future.schema += "-future"
    guard case .unavailable(.incompatibleSchema) = try s.readReviewRevision(revision: future, availableKeyProfile: nil) else { throw Failure(message: "incompatible schema") }
    try s.setReviewRetention(maxRevisions: 1, maxTotalBytes: 32 * 1024 * 1024)
    guard case .unavailable(.pruned) = try s.readReviewRevision(revision: locked, availableKeyProfile: nil) else { throw Failure(message: "pruned result") }
    try require(!bytes(s, open).isEmpty, "retained capture")
}
run("stale-capture-binding-and-authorship-rejections") {
    let (_, s) = try fixture(3); defer { try? s.dispose() }
    let old = try capture(s, "old"); _ = try edit(s, "")
    try expect({ if case .Revision(.stale, _) = $0 { return true }; return false }) {
        _ = try s.captureReviewRevision(revision: old.observedRevision, name: "stale", requiredKeyProfile: nil)
    }
    var bad = old; bad.hash[0] ^= 1
    try expect({ if case .ReviewInput(.hashMismatch) = $0 { return true }; return false }) {
        _ = try s.readReviewRevision(revision: bad, availableKeyProfile: nil)
    }
    let current = try capture(s, "current")
    let wire = try compare(s, old, current)
    var json = try JSONSerialization.jsonObject(with: wire.json) as! [String: Any]
    var input = json["input"] as! [String: Any]; var model = input["model"] as! [String: Any]
    model["attribution"] = "forged-author"; input["model"] = model; json["input"] = input
    let forged = try JSONSerialization.data(withJSONObject: json)
    try expect({ if case .ReviewInput(.invalid) = $0 { return true }; return false }) {
        _ = try s.validateChangeModel(bytes: forged, maxBytes: limit)
    }
    try expect({ if case .ResourceLimit = $0 { return true }; return false }) {
        _ = try s.compareReviewRevisions(before: old, after: current, beforeKeyProfile: nil, afterKeyProfile: nil, maxBytes: 1)
    }
}
run("readonly-review-disposal-and-owned-data") {
    let (_, s) = try fixture(4); defer { try? s.dispose() }
    try s.setPermission(writable: false, expiresAt: 0)
    let r = try capture(s, "readonly"); let data = try bytes(s, r)
    let wire = try compare(s, r, r)
    try s.dispose()
    let operations: [() throws -> Void] = [
        { _ = try s.readReviewRevision(revision: r, availableKeyProfile: nil) },
        { _ = try s.captureReviewRevision(revision: r.observedRevision, name: "disposed", requiredKeyProfile: nil) },
        { _ = try s.compareReviewRevisions(before: r, after: r, beforeKeyProfile: nil, afterKeyProfile: nil, maxBytes: limit) },
        { _ = try s.validateChangeModel(bytes: wire.json, maxBytes: limit) },
        { try s.setReviewRetention(maxRevisions: 0, maxTotalBytes: 0) },
    ]
    for operation in operations { try expect({ if case .Disposed = $0 { return true }; return false }, operation) }
    try require(!data.isEmpty && !wire.json.isEmpty, "owned results survive")
}
let failed = results.filter { !($0["passed"] as! Bool) }.count
let result: [String: Any] = ["executed": results.count, "passed": results.count - failed, "failed": failed, "skipped": 0, "cases": results]
print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
if failed > 0 { exit(1) }
