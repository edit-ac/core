import Foundation

struct Failure: Error { let message: String }
func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw Failure(message: message) }
}
func expect(_ match: (NativeSessionError) -> Bool, _ operation: () throws -> Void) throws {
    do { try operation() } catch let error as NativeSessionError {
        try require(match(error), "unexpected typed failure: \(error)"); return
    }
    throw Failure(message: "missing typed failure")
}
// Populated by the separate instrumented generated-source build only.
// A lock also makes observations valid during the parallel caller cases.
enum BufferProbe {
    static let lock = NSLock()
    static var lifts = 0
    static var frees = 0
    static var handles = 0
    static var outstanding: Set<UInt> = []
    static func lift(_ p: UnsafeMutablePointer<UInt8>?) {
        guard let p = p else { return }
        lock.lock(); defer { lock.unlock() }
        outstanding.insert(UInt(bitPattern: p)); lifts += 1
    }
    static func free(_ p: UnsafeMutablePointer<UInt8>?) {
        guard let p = p else { return }
        lock.lock(); defer { lock.unlock() }
        if outstanding.remove(UInt(bitPattern: p)) != nil { frees += 1 }
    }
    static func event(_ event: String) {
        lock.lock(); defer { lock.unlock() }
        if event == "lift" { lifts += 1 }
        if event == "free" { frees += 1 }
        if event == "handle" { handles += 1 }
    }
}
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let instrumented = CommandLine.arguments.contains("--instrumented")
var next = 0
func options() -> NativeSessionOptions {
    next += 1
    return NativeSessionOptions(path: root.appendingPathComponent("case-\(next).sqlite").path,
        documentId: String(format: "a9300000-0000-4000-8000-%012d", next),
        epoch: "a9400000-0000-4000-8000-000000000001", writable: true, permissionExpiresAt: nil)
}
func create(_ o: NativeSessionOptions) throws -> NativeSession {
    try NativeSession.createLocal(options: o, initial: [NativeSessionSeed(kind: "block", text: "A🦀B")])
}
func prepare(_ s: NativeSession, _ text: String) throws -> String {
    let r = try s.read(now: 0)
    return try s.prepareEdits(revision: r.revision!, edits: [NativeSessionEdit(node: r.nodes[0].id,
        fromUtf16: 1, toUtf16: 3, text: text)], origin: "swift-session", now: 0)
}
func text(_ s: NativeSession) throws -> String { try s.read(now: 0).nodes[0].text }
var cases: [[String: Any]] = []
func test(_ id: String, _ body: () throws -> Void) {
    let selectors = CommandLine.arguments.enumerated().compactMap { index, arg in
        arg == "--case" && index + 1 < CommandLine.arguments.count ? CommandLine.arguments[index + 1] : nil
    }
    if !selectors.isEmpty && !selectors.contains(id) { return }
    do { try body(); cases.append(["id": id, "passed": true]) }
    catch { cases.append(["id": id, "passed": false, "error": String(describing: error)]) }
}
// One real generated handle family and real shared Session for every case.
test("durable-create-history-reopen") {
    let o = options(); let s = try create(o); defer { try? s.dispose() }
    let before = try s.read(now: 0)
    try require(before.locallyCommitted && before.canApply && before.canHistory, "creation state")
    try require(before.localDurability == .processCrash && before.revision?.count == 65, "durable revision")
    let plan = try prepare(s, "xy")
    try require(try text(s) == "A🦀B", "prepare mutated")
    let c = try s.commitEdits(token: plan, now: 0)!
    try require(c.sequence == 1 && c.checksum.count == 32 && c.durability == .processCrash, "receipt")
    try require(try text(s) == "AxyB", "commit")
    _ = try s.undo(revision: s.read(now: 0).revision!, now: 0)
    try require(try text(s) == "A🦀B", "undo")
    _ = try s.redo(revision: s.read(now: 0).revision!, now: 0)
    try s.dispose()
    let restored = try NativeSession.open(options: o); defer { try? restored.dispose() }
    try require(try text(restored) == "AxyB", "reopen")
    try require(before.nodes[0].text == "A🦀B", "detached value changed")
}
test("typed-store-and-identity-failures") {
    let o = options()
    try expect({ if case .Store(reason: .unavailable) = $0 { return true }; return false }) { _ = try NativeSession.open(options: o) }
    try require(!FileManager.default.fileExists(atPath: o.path), "open created file")
    let s = try create(o); defer { try? s.dispose() }
    try expect({ if case .Store = $0 { return true }; return false }) { _ = try create(o) }
    var wrong = o; wrong.epoch = "a9500000-0000-4000-8000-000000000001"
    try expect({ if case .Store(reason: .incompatible) = $0 { return true }; return false }) { _ = try NativeSession.open(options: wrong) }
    try require(try text(s) == "A🦀B", "failed open changed existing data")
}
test("atomic-invalid-batch-and-utf16") {
    let s = try create(options()); defer { try? s.dispose() }; let r = try s.read(now: 0)
    let good = NativeSessionEdit(node: r.nodes[0].id, fromUtf16: 0, toUtf16: 0, text: "valid")
    let bad = NativeSessionEdit(node: r.nodes[0].id, fromUtf16: 7, toUtf16: 7, text: "split")
    try expect({ if case .Engine = $0 { return true }; return false }) {
        _ = try s.prepareEdits(revision: r.revision!, edits: [good, bad], origin: "swift", now: 0)
    }
    try require(try s.read(now: 0).revision == r.revision && text(s) == "A🦀B", "atomic rejection")
}
test("typed-malformed-and-stale-revision") {
    let s = try create(options()); defer { try? s.dispose() }; let r = try s.read(now: 0)
    try expect({ if case .Revision(reason: .invalidToken, message: _) = $0 { return true }; return false }) {
        _ = try s.prepareEdits(revision: Data([0]), edits: [], origin: "swift", now: 0)
    }
    let stale = try prepare(s, "old"); _ = try s.commitEdits(token: prepare(s, "new"), now: 0)
    try expect({ if case .Revision(reason: .stale, message: _) = $0 { return true }; return false }) { _ = try s.commitEdits(token: stale, now: 0) }
    try require(try s.read(now: 0).revision != r.revision && text(s) == "AnewB", "stale mutated")
}
test("permission-rechecked-at-commit") {
    let s = try create(options()); defer { try? s.dispose() }; let token = try prepare(s, "x")
    try s.setPermission(writable: false, expiresAt: nil)
    try expect({ if case .ReadOnly = $0 { return true }; return false }) { _ = try s.commitEdits(token: token, now: 0) }
    try s.setPermission(writable: true, expiresAt: 1)
    let r = try s.read(now: 2)
    try require(!r.canApply, "expiry capability")
    try expect({ if case .PermissionExpired = $0 { return true }; return false }) {
        _ = try s.prepareEdits(revision: r.revision!, edits: [], origin: "swift", now: 2)
    }
    try require(try text(s) == "A🦀B", "permission failure mutated")
}
test("cancel-single-use-and-writer-scope") {
    let o = options(); let s = try create(o); let other = try NativeSession.open(options: o)
    defer { try? s.dispose(); try? other.dispose() }
    let p = try prepare(s, "x")
    try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try other.commitEdits(token: p, now: 0) }
    try s.cancelEdits(token: p); try s.cancelEdits(token: p)
    try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitEdits(token: p, now: 0) }
    let committed = try prepare(s, "y"); _ = try s.commitEdits(token: committed, now: 0)
    try s.cancelEdits(token: committed)
    try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitEdits(token: committed, now: 0) }
    try require(try text(s) == "AyB", "cancel undid accepted commit")
}
test("owned-buffers-after-disposal-and-arc") {
    let o = options(); var s: NativeSession? = try create(o); weak var weakSession = s
    let before = try s!.read(now: 0); let export = try s!.recoveryExport()
    let bytes = export.checkpoint.bytes
    try require(export.locallyCommitted && export.unjournaledUpdate == nil && !bytes.isEmpty, "recovery export")
    for _ in 0..<128 {
        let r = try s!.read(now: 0); let e = try s!.recoveryExport()
        try require(r == before && e.checkpoint.bytes == bytes, "owned repeated conversion")
    }
    try s!.dispose(); s = nil
    try require(weakSession == nil, "Swift object leaked")
    try require(before.nodes[0].text == "A🦀B" && export.checkpoint.bytes == bytes, "owned buffers lost")
    let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
    try require(try text(reopened) == "A🦀B", "store teardown")
}
test("foreign-alias-last-reference-teardown") {
    let o = options(); var s: NativeSession? = try create(o)
    var alias: NativeSession? = try FfiConverterTypeNativeSession.lift(s!.uniffiCloneHandle())
    weak var weakOriginal = s; s = nil
    try require(weakOriginal == nil && text(alias!) == "A🦀B", "alias did not retain Rust Session")
    _ = try alias!.commitEdits(token: prepare(alias!, "z"), now: 0)
    weak var weakAlias = alias; alias = nil
    try require(weakAlias == nil, "last foreign wrapper leaked")
    let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
    try require(try text(reopened) == "AzB", "last-reference persistence")
}
test("alias-wide-post-disposal") {
    let s = try create(options()); let alias = try FfiConverterTypeNativeSession.lift(s.uniffiCloneHandle())
    let r = try s.read(now: 0); let token = try prepare(s, "x")
    try alias.dispose(); try s.dispose()
    let operations: [() throws -> Void] = [
        { _ = try s.read(now: 0) }, { _ = try alias.recoveryExport() }, { try alias.recover() },
        { _ = try s.prepareEdits(revision: r.revision!, edits: [], origin: "swift", now: 0) },
        { _ = try s.commitEdits(token: token, now: 0) }, { try alias.cancelEdits(token: token) },
        { try s.setPermission(writable: true, expiresAt: nil) },
        { _ = try s.undo(revision: r.revision!, now: 0) }, { _ = try s.redo(revision: r.revision!, now: 0) }]
    for op in operations { try expect({ if case .Disposed = $0 { return true }; return false }, op) }
}
// Concurrent calls begin together; their only accepted order is the Rust executor order.
// No callback API exists; neither Session nor generated metadata contains a callback.
final class Results: @unchecked Sendable {
    let lock = NSLock(); var outcomes: [String] = []
    func add(_ s: String) { lock.lock(); outcomes.append(s); lock.unlock() }
}
func race(_ operations: [() -> Void]) {
    let gate = DispatchSemaphore(value: 0); let group = DispatchGroup()
    for op in operations { group.enter(); DispatchQueue.global().async { gate.wait(); op(); group.leave() } }
    for _ in operations { gate.signal() }; group.wait()
}
test("serialized-concurrent-single-use-commit") {
    let s = try create(options()); defer { try? s.dispose() }; let p = try prepare(s, "x"); let result = Results()
    race((0..<16).map { _ in { do { _ = try s.commitEdits(token: p, now: 0); result.add("commit") }
        catch NativeSessionError.InvalidPlan { result.add("consumed") } catch { result.add("unexpected: \(error)") } } })
    try require(result.outcomes.filter { $0 == "commit" }.count == 1 && result.outcomes.filter { $0 == "consumed" }.count == 15, "single-use serialization: \(result.outcomes)")
    try require(try text(s) == "AxB", "concurrent mutation")
}
test("ordered-cancel-versus-commit") {
    let s = try create(options()); defer { try? s.dispose() }; let p = try prepare(s, "x"); let result = Results()
    race([{ do { try s.cancelEdits(token: p); result.add("cancel") } catch { result.add("unexpected") } },
          { do { _ = try s.commitEdits(token: p, now: 0); result.add("commit") }
            catch NativeSessionError.InvalidPlan { result.add("canceled") } catch { result.add("unexpected") } }])
    let t = try text(s)
    try require(result.outcomes.contains("cancel") && ((result.outcomes.contains("commit") && t == "AxB") || (result.outcomes.contains("canceled") && t == "A🦀B")), "cancel order")
}
test("ordered-dispose-versus-accepted-commit") {
    let o = options(); let s = try create(o); let p = try prepare(s, "x"); let result = Results()
    race([{ do { try s.dispose(); result.add("dispose") } catch { result.add("unexpected") } },
          { do { _ = try s.commitEdits(token: p, now: 0); result.add("commit") }
            catch NativeSessionError.Disposed { result.add("disposed") } catch { result.add("unexpected") } }])
    try require(result.outcomes.contains("dispose"), "disposal failed")
    try expect({ if case .Disposed = $0 { return true }; return false }) { _ = try s.read(now: 0) }
    let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
    let t = try text(reopened)
    try require((result.outcomes.contains("commit") && t == "AxB") || (result.outcomes.contains("disposed") && t == "A🦀B"), "dispose did not await accepted commit")
}
runCommandCases()
runTablePolicyCases()
runRemoteCases()
if let index = CommandLine.arguments.firstIndex(of: "--rich-fixture") {
    runRichCases(CommandLine.arguments[index + 1])
}
if instrumented {
    test("generated-buffer-and-handle-cleanup") {
        try require(BufferProbe.lifts > 256 && BufferProbe.lifts == BufferProbe.frees && BufferProbe.outstanding.isEmpty, "buffer lift/free mismatch: \(BufferProbe.lifts)/\(BufferProbe.frees)")
        try require(BufferProbe.handles > 12, "foreign reference teardown not observed")
    }
}
let failed = cases.filter { !($0["passed"] as! Bool) }.count
let report: [String: Any] = ["cases": cases,
    "counts": ["executed": cases.count, "passed": cases.count - failed, "failed": failed, "skipped": 0],
    "instrumented": instrumented, "bufferLifts": BufferProbe.lifts, "bufferFrees": BufferProbe.frees,
    "foreignFrees": BufferProbe.handles,
    "qualification": "actual macOS Swift generated UniFFI / real shared Session SQLite; no AppKit/IME/platform/release claim"]
print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
exit(failed == 0 ? 0 : 1)
