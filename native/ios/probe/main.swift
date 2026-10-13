import Foundation

// Counters are populated only by the separate instrumented generated-source build.
// All calls in this headless probe are serial; this is not a concurrency profiler.
enum BoundaryProbe {
    static var events: [String: Int] = [:]
    static var bytes: [String: Int] = [:]
    static func record(_ key: String, _ size: Int = 0) {
        events[key, default: 0] += 1
        bytes[key, default: 0] += size
    }
    static func reset() { events = [:]; bytes = [:] }
}
struct ProbeFailure: Error { let message: String }
func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw ProbeFailure(message: message) }
}
func json(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}
func object(_ value: String) throws -> [String: Any] {
    guard let result = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else {
        throw ProbeFailure(message: "expected JSON object")
    }
    return result
}
func expectError(_ kind: String, _ operation: () throws -> Void) throws {
    do { try operation() } catch let error as NativeError {
        let actual: String
        switch error {
        case .InvalidInput: actual = "InvalidInput"
        case .EngineRejected: actual = "EngineRejected"
        case .InvalidHandle: actual = "InvalidHandle"
        case .ResourceLimit: actual = "ResourceLimit"
        case .Disposed: actual = "Disposed"
        case .ExecutorUnavailable: actual = "ExecutorUnavailable"
        }
        try require(actual == kind, "expected \(kind), got \(actual)")
        return
    }
    throw ProbeFailure(message: "expected typed \(kind) error")
}
let args = CommandLine.arguments
let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [String: Any]
let initial = fixture["initialText"] as! String
let expected = fixture["expectedText"] as! String
func create(_ serial: Int) throws -> NativeEngine {
    try NativeEngine.create(inputJson: json([
        "profile": fixture["profile"]!, "epoch": fixture["epoch"]!,
        "documentId": String(format: "a8000000-0000-4000-8000-%012d", serial),
        "nodes": [["text": initial]]
    ]))
}
func snapshot(_ engine: NativeEngine) throws -> [String: Any] {
    var result = try object(engine.read())
    result.removeValue(forKey: "changedNodes"); result.removeValue(forKey: "touchedRanges")
    return result
}
func text(_ snapshot: [String: Any]) -> String {
    let node = (snapshot["visible"] as! [[String: Any]])[0]
    return (node["runs"] as! [[String: Any]]).map { $0["text"] as! String }.joined()
}
func anchor(_ engine: NativeEngine, _ offset: UInt32) throws -> String {
    let node = (try snapshot(engine)["visible"] as! [[String: Any]])[0]["id"] as! String
    return try engine.captureAnchor(input: AnchorInput(node: node, offsetUtf16: offset, bias: .right))
}
func commands(_ engine: NativeEngine) throws -> String {
    let at = try anchor(engine, UInt32(fixture["insertOffsetUtf16"] as! Int))
    let end = try anchor(engine, UInt32(fixture["suffixOffsetUtf16"] as! Int))
    return try json(["kind": "editor", "origin": "native-fixture", "commands": [
        ["type": "insert", "at": at, "text": fixture["insertText"]!],
        ["type": "insert", "at": end, "text": fixture["suffixText"]!]
    ]])
}
func restoreInput(_ checkpoint: OwnedCheckpoint) throws -> String {
    var input = try object(checkpoint.metadataJson)
    input["expected"] = input["identity"]; input["journal"] = [Any]()
    return try json(input)
}
func restore(_ engine: NativeEngine) throws -> NativeEngine {
    let c = try engine.checkpoint()
    return try NativeEngine.restore(inputJson: restoreInput(c), bytes: c.bytes)
}
var cases: [(String, () throws -> [String: Any])] = []
cases.append(("schema", {
    let v = abiVersion()
    try require(v.abiVersion == 1 && v.offsetUnits == "utf16" && v.updateEncoding == 1 && v.uniffiVersion == "0.32.2", "ABI versions")
    try require(v.schema == "editac.registry.editor.v5" && v.profile == "editac.yrs-yjs.editor.v5", "schema/profile")
    return ["abi": 1, "offsets": v.offsetUnits, "uniffi": v.uniffiVersion]
}))
cases.append(("unicode-batch-patch", {
    let e = try create(1); defer { try? e.dispose() }
    let before = try snapshot(e); let c = try e.checkpoint(); let saved = c.bytes
    try require(text(before) == initial && initial.utf16.count == fixture["initialUtf16Units"] as! Int, "initial Unicode")
    let end = try anchor(e, UInt32(fixture["suffixOffsetUtf16"] as! Int))
    let result = try e.executeBatch(commandsJson: commands(e)); let patch = try object(result.patchJson)
    let actual = text(try snapshot(e))
    try require(actual == expected && actual.utf16.count == fixture["expectedUtf16Units"] as! Int, "UTF-16 batch semantics")
    try require(patch["version"] as? Int == 1 && patch["sequence"] as? Int == 1, "patch version/sequence")
    try require((patch["changedNodes"] as? [Any])?.count == 1 && (patch["nodes"] as? [Any])?.count == 1, "one detached patch node")
    try require((patch["identity"] as? [String: Any])?["offsets"] as? String == "utf16", "patch offsets")
    let resolved = try object(e.resolveAnchor(token: end))
    try require(resolved["offset"] as? Int == actual.utf16.count, "relative end anchor")
    let drained = try e.takePatch(); try require(drained == "null", "synchronous patch consumed")
    try e.dispose()
    try require(c.bytes == saved && !c.bytes.isEmpty && text(before) == initial, "owned output survives disposal")
    return ["expectedText": expected, "actualText": actual, "utf16": actual.utf16.count, "patchVersion": 1, "changedNodes": 1, "checkpointBytes": c.bytes.count]
}))
cases.append(("checkpoint-restore", {
    let e = try create(2); defer { try? e.dispose() }
    _ = try e.executeBatch(commandsJson: commands(e))
    let c = try e.checkpoint(); let r = try restore(e); defer { try? r.dispose() }
    try require(text(try snapshot(r)) == expected, "restored text")
    let left = try snapshot(e); let right = try snapshot(r)
    try require(try json(left["identity"]!) == json(right["identity"]!), "restore identity")
    let oldMeta = try object(c.metadataJson); let newMeta = try object(r.checkpoint().metadataJson)
    try require(oldMeta["writerId"] as? NSNumber != newMeta["writerId"] as? NSNumber, "new restore writer")
    var bad = try object(restoreInput(c)); var identity = bad["expected"] as! [String: Any]; identity["offsets"] = "utf8"; bad["expected"] = identity
    try expectError("EngineRejected") { _ = try NativeEngine.restore(inputJson: json(bad), bytes: c.bytes) }
    return ["actualText": text(right), "identityPreserved": true, "newWriter": true, "rejectedOffsets": "utf8"]
}))
cases.append(("remote-update-anchor-history", {
    let e = try create(3); defer { try? e.dispose() }
    let r = try restore(e); defer { try? r.dispose() }
    let at = try anchor(e, UInt32(fixture["insertOffsetUtf16"] as! Int))
    let imported = try r.importAnchor(portableJson: e.exportAnchor(token: at))
    let vector = try r.stateVector()
    _ = try e.executeBatch(commandsJson: commands(e))
    let update = try e.encodeUpdate(vector: vector)
    try require(!update.isEmpty, "real update bytes")
    let identity = try snapshot(e)["identity"]!
    let result = try r.applyUpdate(identityJson: json(identity), bytes: update)
    let patch = try object(result.patchJson)
    try require(patch["operation"] as? String == "Remote" && text(try snapshot(r)) == expected, "remote semantics")
    let resolved = try object(r.resolveAnchor(token: imported)); try require(resolved["offset"] as? Int == 4, "portable anchor")
    try r.releaseAnchor(token: imported)
    try expectError("InvalidHandle") { _ = try r.resolveAnchor(token: imported) }
    let undo = try e.history(requestJson: json(["type": "undo"]))
    try require(undo.patchJson != "null" && text(try snapshot(e)) == initial, "history semantics")
    return ["actualText": expected, "updateBytes": update.count, "stateVectorBytes": vector.count, "operation": "Remote", "anchorOffset": 4, "undoText": initial]
}))
cases.append(("typed-pre-mutation-errors", {
    let e = try create(4); defer { try? e.dispose() }
    let before = try json(snapshot(e)); let at = try anchor(e, 3)
    let invalid = try json(["kind": "editor", "origin": "native-fixture", "commands": [
        ["type": "insert", "at": at, "text": "X"], ["type": "insert", "at": "missing", "text": "Y"]]])
    try expectError("InvalidHandle") { _ = try e.executeBatch(commandsJson: invalid) }
    try expectError("EngineRejected") { _ = try anchor(e, UInt32(fixture["invalidSurrogateOffsetUtf16"] as! Int)) }
    try expectError("InvalidInput") { _ = try e.executeBatch(commandsJson: "{") }
    try expectError("InvalidInput") { _ = try NativeEngine.create(inputJson: "{}") }
    try expectError("ResourceLimit") { _ = try e.executeBatch(commandsJson: String(repeating: " ", count: 2 * 1024 * 1024 + 1)) }
    try require(try json(snapshot(e)) == before, "errors preserve entire semantic snapshot")
    let patch = try e.takePatch(); try require(patch == "null", "errors emit no patch")
    return ["types": ["InvalidHandle", "EngineRejected", "InvalidInput", "ResourceLimit"], "atomic": true]
}))
cases.append(("cancel-commit-dispose", {
    let e = try create(5); defer { try? e.dispose() }; let alias = e
    let input = try commands(e); let before = try json(snapshot(e))
    let canceled = try e.prepareBatch(commandsJson: input)
    try require(try json(snapshot(e)) == before, "prepare does not mutate")
    try e.cancelBatch(token: canceled); try e.cancelBatch(token: canceled)
    try expectError("InvalidHandle") { _ = try e.commitBatch(token: canceled) }
    try require(try json(snapshot(e)) == before, "cancel does not mutate")
    let token = try e.prepareBatch(commandsJson: input); let result = try e.commitBatch(token: token)
    try require(result.patchJson != "null" && text(try snapshot(e)) == expected, "prepared commit")
    try expectError("InvalidHandle") { _ = try e.commitBatch(token: token) }
    let owned = try e.checkpoint(); try e.dispose(); try e.dispose()
    try expectError("Disposed") { _ = try alias.read() }
    try expectError("Disposed") { _ = try e.commitBatch(token: token) }
    try expectError("Disposed") { try e.cancelBatch(token: "missing") }
    try require(!owned.bytes.isEmpty, "owned checkpoint after disposal")
    return ["idempotentCancel": true, "singleCommit": true, "aliasDisposed": true, "ownedBytes": owned.bytes.count]
}))
cases.append(("arc-final-reference", {
    weak var released: NativeEngine?
    do { let e = try create(6); released = e; try require(text(try snapshot(e)) == initial, "ARC engine usable") }
    try require(released == nil, "final foreign ARC reference released")
    return ["weakReferenceReleased": true, "rustJoin": "Rust Drop owns executor join; Swift weak release observes foreign ownership only"]
}))
cases.append(("all-byte-values", {
    let bytes = Data((0...255).map { UInt8($0) })
    let value = OwnedCheckpoint(metadataJson: "byte-codec-fixture", bytes: bytes)
    let lifted = try FfiConverterTypeOwnedCheckpoint_lift(FfiConverterTypeOwnedCheckpoint_lower(value))
    try require(lifted == value && lifted.bytes.count == 256, "generated record preserves all byte values")
    return ["byteValues": 256, "scope": "actual generated lower/lift codec; engine cases separately use real CRDT bytes"]
}))
cases.append(("boundary-copies", {
    let e = try create(7); defer { try? e.dispose() }; let input = try commands(e)
    BoundaryProbe.reset()
    let result = try e.executeBatch(commandsJson: input)
    let batchEvents = BoundaryProbe.events; let batchBytes = BoundaryProbe.bytes
    try require(batchEvents["call.executeBatch"] == 1 && batchEvents.filter { $0.key.hasPrefix("call.") }.count == 1, "one batch method call")
    try require(batchEvents["copy.host-to-rust"] == 1 && batchBytes["copy.host-to-rust"] == input.utf8.count, "one input boundary buffer copy")
    try require(batchEvents["decode.string-field"] == 2 && batchBytes["decode.string-field"] == result.resultJson.utf8.count + result.patchJson.utf8.count, "two owned output strings")
    let c = try e.checkpoint(); let restoreJson = try restoreInput(c)
    BoundaryProbe.reset()
    let r = try NativeEngine.restore(inputJson: restoreJson, bytes: c.bytes)
    let restoreEvents = BoundaryProbe.events; let restoreBytes = BoundaryProbe.bytes
    try r.dispose()
    try require(restoreEvents["call.restore"] == 1 && restoreEvents["copy.host-to-rust"] == 2, "restore input JSON and binary buffers")
    try require(restoreBytes["copy.host-to-rust"] == restoreJson.utf8.count + c.bytes.count + 4, "restore bytes with length prefix")
    return ["batchEvents": batchEvents, "batchBytes": batchBytes, "restoreEvents": restoreEvents, "restoreBytes": restoreBytes,
            "scope": "observed generated conversion sites and payload bytes; excludes allocator internals, Rust staging copies and timing"]
}))
let selected = args.count > 2 ? args[2] : "all"
let chosen = cases.filter { selected == "all" ? $0.0 != "boundary-copies" : $0.0 == selected }
if chosen.isEmpty { fputs("zero matching cases\n", stderr); exit(2) }
var results: [[String: Any]] = []
for (name, run) in chosen {
    do { results.append(["id": name, "passed": true, "observations": try run()]) }
    catch { results.append(["id": name, "passed": false, "error": String(reflecting: error)]) }
}
let failed = results.filter { $0["passed"] as? Bool == false }.count
print(try json(["cases": results, "counts": ["executed": chosen.count, "passed": chosen.count - failed, "failed": failed, "skipped": 0]]))
exit(failed == 0 ? 0 : 1)
