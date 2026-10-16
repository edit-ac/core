import Foundation

enum ProofFailure: Error { case failed(String) }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProofFailure.failed(message) }
}
func rejects(_ body: () throws -> Void) throws {
    do { try body() } catch { return }
    throw ProofFailure.failed("expected rejection")
}
func wire(_ value: Any) throws -> String {
    String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
}
func visible(_ s: NativeSession) throws -> [[String: Any]] {
    let snapshot = try JSONSerialization.jsonObject(with: Data(s.richSnapshot().snapshotJson.utf8)) as! [String: Any]
    return snapshot["visible"] as! [[String: Any]]
}
func revision(_ s: NativeSession) throws -> Data { try s.read(now: 0).revision! }
func prepare(_ s: NativeSession, _ commands: [[String: Any]]) throws -> NativePreparedCommands {
    try s.prepareCommands(revision: revision(s), commandsJson: wire(commands), origin: "swift-extension-proof", now: 0)
}
func mark(_ s: NativeSession, value: Any) throws -> [String: Any] {
    ["type": "customMarkAt", "owner": try s.read(now: 0).nodes[0].id,
     "from": 1, "to": 3, "key": "module:fixture.note", "value": value]
}
var results: [[String: Any]] = []
func test(_ name: String, _ body: () throws -> Void) {
    do { try body(); results.append(["id": name, "passed": true]) }
    catch { results.append(["id": name, "passed": false, "error": String(describing: error)]) }
}
let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let registry = fixture["registry"] as! String
let directory = fixture["directory"] as! String
func options() -> NativeSessionOptions {
    NativeSessionOptions(path: directory + "/swift-" + UUID().uuidString + ".sqlite",
        documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(), writable: true, permissionExpiresAt: nil)
}
func create(_ options: NativeSessionOptions) throws -> NativeSession {
    try NativeSession.createLocalWithRegistry(options: options,
        initial: [NativeSessionSeed(kind: "block", text: "A🦀B")], registryJson: registry)
}
test("generated-registry-validation-before-create") {
    let o = options()
    try rejects { _ = try NativeSession.createLocalWithRegistry(options: o, initial: [], registryJson: "[{}]") }
    try require(!FileManager.default.fileExists(atPath: o.path), "invalid registry created store")
}
test("generated-custom-mark-durable-history-reopen") {
    let o = options(); let s = try create(o); defer { try? s.dispose() }
    try s.setExtensionPolicy(enabled: true)
    let before = try wire(visible(s)); let command = try mark(s, value: [1, ["label": "swift"]] as [Any])
    let p = try prepare(s, [command]); try require(try wire(visible(s)) == before, "prepare changed document")
    let c = try s.commitCommands(token: p.token, now: 0)!
    try require(c.sequence == 1 && c.checksum.count == 32, "missing exact durable commit")
    let after = try wire(visible(s)); try require(after != before, "mark missing")
    try require(try s.historyState(now: 0).undoGroups == 1, "not one history group")
    _ = try s.undo(revision: revision(s), now: 0)
    try require(try wire(visible(s)) == before, "undo mismatch")
    _ = try s.redo(revision: revision(s), now: 0); try s.dispose()
    let reopened = try NativeSession.openWithRegistry(options: o, registryJson: registry); defer { try? reopened.dispose() }
    try require(try wire(visible(reopened)) == after, "reopen lost custom mark")
}
test("generated-permission-policy-cancel-revision-disposal") {
    let s = try create(options()); defer { try? s.dispose() }
    let command = try mark(s, value: [1, ["label": "guard"]] as [Any])
    try rejects { _ = try prepare(s, [command]) }
    try s.setExtensionPolicy(enabled: true)
    let p = try prepare(s, [command]); try s.setPermission(writable: false, expiresAt: nil)
    try rejects { _ = try s.commitCommands(token: p.token, now: 0) }
    try s.setPermission(writable: true, expiresAt: nil)
    let p2 = try prepare(s, [command]); try s.cancelCommands(token: p2.token)
    try rejects { _ = try s.commitCommands(token: p2.token, now: 0) }
    let stale = try prepare(s, [command]); let live = try prepare(s, [command])
    _ = try s.commitCommands(token: live.token, now: 0)
    try rejects { _ = try s.commitCommands(token: stale.token, now: 0) }
    let disposed = try prepare(s, [command]); try s.dispose()
    try rejects { _ = try s.commitCommands(token: disposed.token, now: 0) }
}
test("generated-math-source-exact-anchor-payload-history") {
    let o = NativeSessionOptions(path: fixture["path"] as! String, documentId: fixture["documentId"] as! String,
        epoch: fixture["epoch"] as! String, writable: true, permissionExpiresAt: nil)
    let s = try NativeSession.openWithRegistry(options: o, registryJson: registry); defer { try? s.dispose() }
    try s.setExtensionPolicy(enabled: true)
    let before = try visible(s); let owner = try s.read(now: 0).nodes[0].id
    let anchor = try s.captureAnchors(revision: revision(s), inputs: [AnchorInput(node: owner, offsetUtf16: 0, bias: .right)])[0].token
    let tuple = before[0]["blockAttributes"] as! [Any]
    var command: [String: Any] = ["type": "extensionSource", "owner": owner, "expected": tuple, "at": anchor, "source": "\\invalid{" ]
    let p = try prepare(s, [command]); try require(try wire(visible(s)) == wire(before), "source prepare mutated")
    _ = try s.commitCommands(token: p.token, now: 0)
    let after = try visible(s); let data = (after[0]["blockAttributes"] as! [Any])[2] as! [String: Any]
    try require(data["source"] as! String == "\\invalid{", "invalid source was rewritten")
    try require(try wire(data["payload"]!) == wire((tuple[2] as! [String: Any])["payload"]!), "unknown payload changed")
    try rejects { _ = try prepare(s, [command]) }
    _ = try s.undo(revision: revision(s), now: 0)
    try require(try wire(visible(s)) == wire(before), "source undo mismatch")
    command["source"] = String(repeating: "x", count: 8193)
    try rejects { _ = try prepare(s, [command]) }
}
let passed = results.filter { $0["passed"] as! Bool }.count
print(try wire(["state": passed == results.count ? "passed" : "failed", "executed": results.count,
    "passed": passed, "failed": results.count - passed, "skipped": 0, "cases": results]))
if passed != results.count { exit(1) }
