import UIKit

struct Failure: Error { let message: String }
func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw Failure(message: message) }
}
func json(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}
func object(_ value: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
}
func visibleText(_ snapshot: [String: Any]) -> String {
    let node = (snapshot["visible"] as! [[String: Any]])[0]
    return (node["runs"] as! [[String: Any]]).map { $0["text"] as! String }.joined()
}

// One fixed text node, intentionally bounded preparation rather than an editor adapter.
// Rust commits first. UIKit owns only temporary marked text. Remote committed output
// is queued while UIKit composes, then projected after explicit cancellation.
final class RangePresenter {
    let view: UITextView
    var pending: String?
    var copies: [[String: Any]] = []
    init(_ view: UITextView) { self.view = view }
    func apply(_ patchJSON: String) throws {
        if view.markedTextRange != nil { pending = patchJSON; return }
        let patch = try object(patchJSON)
        try require(patch["version"] as? Int == 1, "patch version")
        let nodes = patch["nodes"] as! [[String: Any]]
        try require(nodes.count == 1 && nodes[0]["type"] as? String == "visible", "one visible patched node")
        let node = nodes[0]["node"] as! [String: Any]
        let next = (node["runs"] as! [[String: Any]]).map { $0["text"] as! String }.joined()
        let old = view.textStorage.string
        // Find a scalar-aligned changed range; public NSRange offsets remain UTF-16.
        let left = Array(old.unicodeScalars), right = Array(next.unicodeScalars)
        var prefix = 0, suffix = 0
        while prefix < min(left.count, right.count) && left[prefix] == right[prefix] { prefix += 1 }
        while suffix < min(left.count, right.count) - prefix && left[left.count-1-suffix] == right[right.count-1-suffix] { suffix += 1 }
        func string(_ scalars: ArraySlice<Unicode.Scalar>) -> String { String(String.UnicodeScalarView(scalars)) }
        let start = string(left[..<prefix]).utf16.count
        let removed = string(left[prefix..<(left.count-suffix)]).utf16.count
        let replacement = string(right[prefix..<(right.count-suffix)])
        let range = NSRange(location: start, length: removed)
        let selection = view.selectedRange
        func remap(_ offset: Int) -> Int {
            if offset < start { return offset }
            if offset >= start + removed { return offset + replacement.utf16.count - removed }
            return start + replacement.utf16.count
        }
        view.textStorage.beginEditing()
        view.textStorage.replaceCharacters(in: range, with: replacement)
        view.textStorage.endEditing()
        let a = remap(selection.location), b = remap(NSMaxRange(selection))
        view.selectedRange = NSRange(location: a, length: b-a)
        copies.append(["operation": patch["operation"]!, "patchJSONUtf8Bytes": patchJSON.utf8.count,
            "oldProjectedUtf16Units": old.utf16.count, "newProjectedUtf16Units": next.utf16.count,
            "rangeStartUtf16": start, "removedUtf16Units": removed,
            "replacementUtf16Units": replacement.utf16.count,
            "replacementUtf8Bytes": replacement.utf8.count, "textStorageReplacements": 1])
        try require(view.textStorage.string == next, "range patch projection")
    }
    func cancelComposition(to committed: String) throws {
        view.unmarkText()
        view.textStorage.replaceCharacters(in: NSRange(location: 0, length: view.textStorage.length), with: committed)
        if let patch = pending { pending = nil; try apply(patch) }
    }
}

@main
final class ProbeApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        window.rootViewController = controller; window.makeKeyAndVisible(); self.window = window
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.run(controller) }
        return true
    }
    func run(_ controller: UIViewController) {
        var cases: [[String: Any]] = []
        var engines: [NativeEngine] = []
        let view = UITextView(usingTextLayoutManager: false) // explicit TextKit 1 NSTextStorage
        view.frame = controller.view.bounds.insetBy(dx: 24, dy: 90)
        view.font = .systemFont(ofSize: 22); controller.view.addSubview(view)
        let presenter = RangePresenter(view)
        var batchCalls = 0, updateCalls = 0, remoteBytes = 0
        func check(_ name: String, _ block: () throws -> [String: Any]) {
            do { cases.append(["id": name, "state": "passed", "observed": try block()]) }
            catch { cases.append(["id": name, "state": "failed", "error": String(describing: error)]) }
        }
        do {
            let data = try Data(contentsOf: Bundle.main.url(forResource: "bounded-abi", withExtension: "json")!)
            let f = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            let initial = f["initialText"] as! String, expected = f["expectedText"] as! String
            let engine = try NativeEngine.create(inputJson: json(["profile": f["profile"]!, "epoch": f["epoch"]!,
                "documentId": "a8000000-0000-4000-8000-000000000015", "nodes": [["text": initial]]]))
            engines.append(engine)
            func read(_ e: NativeEngine) throws -> [String: Any] { try object(e.read()) }
            func insert(_ e: NativeEngine, _ offset: Int, _ text: String) throws -> [String: Any] {
                let id = (try read(e)["visible"] as! [[String: Any]])[0]["id"] as! String
                let at = try e.captureAnchor(input: AnchorInput(node: id, offsetUtf16: UInt32(offset), bias: .right))
                return ["type": "insert", "at": at, "text": text]
            }
            func batch(_ e: NativeEngine, _ commands: [[String: Any]], _ origin: String) throws -> BatchResult {
                defer { for command in commands { if let at = command["at"] as? String { try? e.releaseAnchor(token: at) } } }
                let result = try e.executeBatch(commandsJson: json(["kind": "editor", "origin": origin, "commands": commands]))
                batchCalls += 1
                return result
            }
            view.text = initial
            check("real-textkit-control") {
                try require(view.layoutManager.textStorage === view.textStorage && view.textLayoutManager == nil, "TextKit1 owns actual storage")
                try require(view.becomeFirstResponder() && view.isFirstResponder, "native text input responder")
                return ["class": NSStringFromClass(type(of: view)), "textKit": 1, "webView": false, "initialUtf16": view.textStorage.length]
            }
            check("local-batched-utf16-range-selection") {
                view.selectedRange = NSRange(location: initial.utf16.count, length: 0)
                let commands = try [insert(engine, f["insertOffsetUtf16"] as! Int, f["insertText"] as! String),
                    insert(engine, f["suffixOffsetUtf16"] as! Int, f["suffixText"] as! String)]
                let result = try batch(engine, commands, "ios-control-local")
                try presenter.apply(result.patchJson)
                try require(view.text == expected && visibleText(try read(engine)) == expected, "shared Rust fixture expectation")
                try require(view.selectedRange == NSRange(location: 8, length: 0), "caret follows local patch")
                return ["text": view.text!, "selectionUtf16": view.selectedRange.location, "commands": 2, "batchCalls": 1]
            }
            let checkpoint = try engine.checkpoint()
            var restore = try object(checkpoint.metadataJson); restore["expected"] = try read(engine)["identity"]!; restore["journal"] = [Any]()
            let peer = try NativeEngine.restore(inputJson: json(restore), bytes: checkpoint.bytes); engines.append(peer)
            check("remote-crdt-range-selection") {
                let vector = try engine.stateVector()
                _ = try batch(peer, [insert(peer, 0, "R")], "ios-peer")
                let update = try peer.encodeUpdate(vector: vector); remoteBytes += update.count
                let result = try engine.applyUpdate(identityJson: json(try read(peer)["identity"]!), bytes: update); updateCalls += 1
                try require(try object(result.patchJson)["operation"] as? String == "Remote", "actual remote patch")
                view.selectedRange = NSRange(location: 3, length: 1)
                try presenter.apply(result.patchJson)
                try require(view.text == "R" + expected && view.selectedRange == NSRange(location: 4, length: 1), "remote range and selection")
                return ["text": view.text!, "selectionStartUtf16": 4, "selectionLengthUtf16": 1, "updateBytes": update.count]
            }
            check("marked-text-rust-ownership-remote-queue") {
                let committed = visibleText(try read(engine))
                view.selectedRange = NSRange(location: view.textStorage.length, length: 0)
                view.setMarkedText("仮", selectedRange: NSRange(location: 1, length: 0))
                try require(view.markedTextRange != nil && view.text == committed + "仮", "UIKit marked text exists")
                try require(visibleText(try read(engine)) == committed, "temporary composition never mutates Rust")
                let vector = try engine.stateVector()
                _ = try batch(peer, [insert(peer, 0, "Q")], "ios-peer-composition")
                let update = try peer.encodeUpdate(vector: vector); remoteBytes += update.count
                let result = try engine.applyUpdate(identityJson: json(try read(peer)["identity"]!), bytes: update); updateCalls += 1
                try presenter.apply(result.patchJson)
                try require(presenter.pending != nil && view.markedTextRange != nil && view.text == committed + "仮", "remote must not overwrite marked text")
                try presenter.cancelComposition(to: committed)
                try require(view.markedTextRange == nil && presenter.pending == nil && view.text == "Q" + committed, "cancel then flush actual remote patch")
                return ["temporaryText": "仮", "rustUnchangedBeforeRemote": true, "remoteQueued": true, "explicitCancelFlush": true,
                    "gap": "Probe cancels composition before remote projection; conflict merge, candidate keyboard, commit/autocorrect/dictation are unqualified"]
            }
            check("custom-mark-textkit-rendering") {
                let key = NSAttributedString.Key("editac.custom.review")
                let range = NSRange(location: 0, length: 1)
                let before = visibleText(try read(engine))
                view.textStorage.addAttributes([key: "review-v1", .backgroundColor: UIColor.systemYellow], range: range)
                view.layoutManager.ensureLayout(for: view.textContainer)
                try require(view.textStorage.attribute(key, at: 0, effectiveRange: nil) as? String == "review-v1", "custom mark retained")
                try require(view.textStorage.attribute(.backgroundColor, at: 0, effectiveRange: nil) is UIColor, "mark has native presentation")
                try require(visibleText(try read(engine)) == before, "presentation does not become committed model")
                return ["supported": true, "scope": "data-only presenter attribute; semantic mark import/export and persistence unqualified"]
            }
            check("inline-native-attachment") {
                let before = visibleText(try read(engine))
                let image = UIGraphicsImageRenderer(size: CGSize(width: 18, height: 18)).image { context in
                    UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 18, height: 18))
                }
                let attachment = NSTextAttachment(); attachment.image = image
                attachment.bounds = CGRect(x: 0, y: -3, width: 18, height: 18)
                let offset = view.textStorage.length
                view.textStorage.append(NSAttributedString(attachment: attachment))
                view.layoutManager.ensureLayout(for: view.textContainer)
                try require(view.textStorage.attribute(.attachment, at: offset, effectiveRange: nil) as? NSTextAttachment === attachment, "real inline attachment")
                try require((view.textStorage.string as NSString).substring(with: NSRange(location: offset, length: 1)) == "\u{fffc}", "UTF16 attachment placeholder")
                try require(visibleText(try read(engine)) == before, "attachment is a presentation-only observation")
                return ["supported": true, "placeholderUtf16Units": 1, "scope": "UIKit presenter only; semantic attachment mapping, export, hit-testing and accessibility unqualified"]
            }
            check("copies-batching-disposal") {
                try require(presenter.copies.count == 3 && batchCalls == 3 && updateCalls == 2 && remoteBytes > 0, "bounded calls and actual replacement counters")
                for e in engines { try e.dispose() }
                do { _ = try engine.read(); throw Failure(message: "disposed read succeeded") }
                catch let error as NativeError {
                    guard case .Disposed = error else { throw error }
                }
                return ["engineBatchCalls": batchCalls, "engineUpdateCalls": updateCalls, "remoteBinaryBytes": remoteBytes,
                    "rangeReplacements": presenter.copies, "gap": "Whole changed-node JSON/string decoding and scalar arrays copy O(node length). Cancellation restores whole committed control text. Internal Rust/UIKit allocations and timing unmeasured."]
            }
        } catch { cases.append(["id": "setup", "state": "failed", "error": String(describing: error)]) }
        for engine in engines { try? engine.dispose() }
        let failed = cases.filter { $0["state"] as? String == "failed" }.count
        let result: [String: Any] = ["gate": "NAT-1.5", "cases": cases,
            "counts": ["executed": cases.count, "passed": cases.count-failed, "failed": failed, "skipped": 0],
            "host": ["system": UIDevice.current.systemVersion, "model": UIDevice.current.model],
            "scope": "iOS Simulator actual UIKit/TextKit and generated native bridge; no physical/IME/SDK/performance/release parity"]
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
        do { try Data(json(result).utf8).write(to: path, options: .atomic) }
        catch { print("RESULT WRITE FAILED: \(error)") }
    }
}
