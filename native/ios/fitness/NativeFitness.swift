import UIKit

private func fitnessJSON(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}
private func decode(_ value: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
}
private func text(_ engine: NativeEngine) throws -> String {
    let node = (try decode(engine.read())["visible"] as! [[String: Any]])[0]
    return (node["runs"] as! [[String: Any]]).map { $0["text"] as! String }.joined()
}
private func rect(_ r: CGRect) -> [String: Double] {
    ["x": r.origin.x, "y": r.origin.y, "width": r.width, "height": r.height]
}
private struct CheckFailure: Error { let message: String }
private func expect(_ b: Bool, _ message: String) throws { if !b { throw CheckFailure(message: message) } }

// Deliberately one bounded owning scenario, not the iOS SDK. Rust commits keyboard
// edits; the native control owns marked text only. Unsupported edits are rejected.
final class FitnessController: UIViewController, UITextViewDelegate {
    let editor = UITextView(usingTextLayoutManager: false)
    let status = UILabel()
    var engine: NativeEngine!
    var initial = ""
    var typed = ""
    var samples: [[String: Any]] = []
    var pending: [[String: Any]] = []
    var frameTrace: [[String: Double]] = []
    var keyboards: [[String: Any]] = []
    var errors: [String] = []
    var attempts: [[String: Any]] = []
    var display: CADisplayLink?
    var composing = false
    var keyboardToken: NSObjectProtocol?
    var fixture: [String: Any] = [:]
    let thermalStart = ProcessInfo.processInfo.thermalState.rawValue
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        editor.frame = CGRect(x: 20, y: 100, width: 350, height: 300)
        editor.font = .systemFont(ofSize: 22)
        editor.accessibilityIdentifier = "native-editor"
        editor.autocorrectionType = .no; editor.spellCheckingType = .no
        editor.smartQuotesType = .no; editor.smartDashesType = .no
        editor.keyboardType = .asciiCapable
        editor.delegate = self
        status.frame = CGRect(x: 20, y: 420, width: 350, height: 50)
        status.accessibilityIdentifier = "scenario-status"; status.text = "ready"
        let finish = UIButton(type: .system)
        finish.frame = CGRect(x: 20, y: 480, width: 350, height: 50)
        finish.setTitle("Verify cancellation and source", for: .normal)
        finish.accessibilityIdentifier = "verify-source"
        finish.addTarget(self, action: #selector(verify), for: .touchUpInside)
        let focus = UIButton(type: .system)
        focus.frame = CGRect(x: 20, y: 50, width: 350, height: 40)
        focus.setTitle("Focus append scenario", for: .normal); focus.accessibilityIdentifier = "focus-append"
        focus.addTarget(self, action: #selector(focusAppend), for: .touchUpInside)
        view.addSubview(focus); view.addSubview(editor); view.addSubview(status); view.addSubview(finish)
        do {
            let data = try Data(contentsOf: Bundle.main.url(forResource: "bounded-abi", withExtension: "json")!)
            fixture = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            initial = fixture["initialText"] as! String
            engine = try NativeEngine.create(inputJson: fitnessJSON(["profile": fixture["profile"]!, "epoch": fixture["epoch"]!,
                "documentId": "a8000000-0000-4000-8000-000000000030", "nodes": [["text": initial]]]))
            editor.text = initial
            editor.selectedRange = NSRange(location: initial.utf16.count, length: 0)
        } catch { errors.append(String(describing: error)); status.text = "setup failed" }
        keyboardToken = NotificationCenter.default.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { [weak self] n in
            let r = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
            self?.keyboards.append(["at": CACurrentMediaTime(), "frame": rect(r), "local": n.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool ?? false])
        }
        display = CADisplayLink(target: self, selector: #selector(frame(_:)))
        display?.add(to: .main, forMode: .common)
        display?.isPaused = true
    }
    @objc func focusAppend() {
        editor.becomeFirstResponder()
        editor.selectedRange = NSRange(location: editor.textStorage.length, length: 0)
    }
    func partial() {
        let value: [String: Any] = ["errors": errors, "attempts": attempts, "typed": typed,
            "committed": (try? text(engine)) ?? "unavailable", "projected": editor.text ?? "",
            "selectionUtf16": editor.selectedRange.location, "samples": samples, "frames": frameTrace]
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("partial.json")
        if let bytes = try? fitnessJSON(value) { try? Data(bytes.utf8).write(to: path, options: .atomic) }
    }
    @objc func frame(_ link: CADisplayLink) {
        // Bounded callback trace; callback completion is not compositor presentation.
        if frameTrace.count < 4096 { frameTrace.append(["callbackAt": CACurrentMediaTime(), "timestamp": link.timestamp, "targetTimestamp": link.targetTimestamp]) }
        guard !pending.isEmpty else { return }
        editor.layoutManager.ensureLayout(for: editor.textContainer)
        for var s in pending {
            s["frameCallbackAt"] = CACurrentMediaTime(); s["displayTimestamp"] = link.timestamp
            s["displayTargetTimestamp"] = link.targetTimestamp
            s["caretRect"] = rect(editor.caretRect(for: editor.selectedTextRange!.end))
            samples.append(s)
        }
        pending.removeAll()
        display?.isPaused = true
        partial()
    }
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
        if composing { return true }
        let start = CACurrentMediaTime()
        attempts.append(["rangeUtf16": range.location, "removedUtf16": range.length, "replacement": replacement])
        do {
            try expect(range.length == 0 && range.location == editor.textStorage.length && !replacement.isEmpty, "only append keyboard scenario accepted")
            let snapshot = try decode(engine.read())
            let id = (snapshot["visible"] as! [[String: Any]])[0]["id"] as! String
            let anchor = try engine.captureAnchor(input: AnchorInput(node: id, offsetUtf16: UInt32(range.location), bias: .right))
            defer { try? engine.releaseAnchor(token: anchor) }
            let result = try engine.executeBatch(commandsJson: fitnessJSON(["kind": "editor", "origin": "prf07-os-keyboard",
                "commands": [["type": "insert", "at": anchor, "text": replacement]]]))
            let engineDone = CACurrentMediaTime()
            let patch = try decode(result.patchJson)
            let node = (patch["nodes"] as! [[String: Any]])[0]["node"] as! [String: Any]
            let next = (node["runs"] as! [[String: Any]]).map { $0["text"] as! String }.joined()
            try expect(next == initial + typed + replacement, "committed source oracle")
            // The one acknowledged append projects a bounded UTF-16 range.
            textView.textStorage.replaceCharacters(in: range, with: replacement)
            textView.selectedRange = NSRange(location: range.location + replacement.utf16.count, length: 0)
            typed += replacement
            pending.append(["inputAt": start, "engineDoneAt": engineDone, "projectionDoneAt": CACurrentMediaTime(),
                "rangeUtf16": range.location, "replacementUtf16": replacement.utf16.count,
                "committedUtf16": next.utf16.count, "thermal": ProcessInfo.processInfo.thermalState.rawValue,
                "inputMode": textView.textInputMode?.primaryLanguage ?? "unavailable"])
            display?.isPaused = false
        } catch { errors.append(String(describing: error)); status.text = "input failed"; partial() }
        return false
    }
    @objc func verify() {
        var cases: [[String: Any]] = []
        func check(_ id: String, _ block: () throws -> [String: Any]) {
            do { cases.append(["id": id, "state": "passed", "observed": try block()]) }
            catch { cases.append(["id": id, "state": "failed", "error": String(describing: error)]) }
        }
        check("os-keyboard-committed-source") {
            try expect(errors.isEmpty && typed == "abcdefghijkl" && (try text(engine)) == initial + typed && editor.text == initial + typed, "OS key edits equal native source")
            try expect(!keyboards.isEmpty, "actual keyboard visibility notification")
            return ["typed": typed, "committed": try text(engine), "selectionUtf16": editor.selectedRange.location]
        }
        check("response-frame-and-caret") {
            try expect(samples.count == 12 && pending.isEmpty && frameTrace.count == 12, "all twelve keyboard edits observed by native display link")
            for s in samples {
                try expect((s["frameCallbackAt"] as! Double) >= (s["projectionDoneAt"] as! Double), "monotone frame attribution")
                let r = s["caretRect"] as! [String: Double]
                try expect(r["height"]! > 0 && r.values.allSatisfy { $0.isFinite }, "native candidate anchor geometry")
            }
            return ["samples": samples.count, "frameCallbacks": frameTrace.count, "geometryScope": "UITextInput caret anchor; candidate window not observed"]
        }
        check("marked-text-cancellation-source-preservation") {
            let before = try text(engine)
            composing = true
            editor.setMarkedText("仮", selectedRange: NSRange(location: 1, length: 0))
            try expect(editor.markedTextRange != nil && (try text(engine)) == before, "marked text stays native")
            let marked = editor.firstRect(for: editor.markedTextRange!)
            editor.unmarkText(); editor.text = before
            editor.selectedRange = NSRange(location: before.utf16.count, length: 0)
            composing = false
            try expect(editor.markedTextRange == nil && editor.text == before && (try text(engine)) == before, "explicit cancellation preserves committed source")
            return ["before": before, "after": try text(engine), "markedRect": rect(marked), "input": "executed UITextInput boundary; not OS CJK candidate selection"]
        }
        check("native-checkpoint-reopen") {
            let cp = try engine.checkpoint()
            var restore = try decode(cp.metadataJson); restore["expected"] = try decode(engine.read())["identity"]!; restore["journal"] = [Any]()
            let reopened = try NativeEngine.restore(inputJson: fitnessJSON(restore), bytes: cp.bytes)
            defer { try? reopened.dispose() }
            try expect((try text(reopened)) == (try text(engine)), "native checkpoint source preserved")
            return ["checkpointBytes": cp.bytes.count, "text": try text(reopened)]
        }
        check("disposal") {
            try engine.dispose()
            do { _ = try engine.read(); throw CheckFailure(message: "disposed read succeeded") }
            catch let e as NativeError { guard case .Disposed = e else { throw e } }
            display?.invalidate(); display = nil
            if let token = keyboardToken { NotificationCenter.default.removeObserver(token); keyboardToken = nil }
            return ["displayLinkInvalidated": display == nil, "keyboardObserverRemoved": keyboardToken == nil]
        }
        let failed = cases.filter { $0["state"] as? String == "failed" }.count
        let record: [String: Any] = ["version": 1, "qualification": "unqualified", "cases": cases,
            "counts": ["executed": cases.count, "passed": cases.count-failed, "failed": failed, "skipped": 0],
            "samples": samples, "frames": frameTrace, "keyboards": keyboards, "errors": errors,
            "host": ["system": UIDevice.current.systemVersion, "model": UIDevice.current.model, "physical": false,
                "thermalStart": thermalStart, "thermalEnd": ProcessInfo.processInfo.thermalState.rawValue,
                "thermalScope": "simulator ProcessInfo observation; physical thermal behavior unavailable", "locale": Locale.current.identifier,
                "refreshMaximum": UIScreen.main.maximumFramesPerSecond],
            "gaps": ["CJK candidate window selection not observed", "XCTest accessibility tree/action is not VoiceOver exploration",
                "display callback is not compositor paint", "12 input samples below unchanged 100-sample tail bar", "no physical thermal inference", "bounded fixture, not Task/Long qualification"]]
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
        do { try Data(fitnessJSON(record).utf8).write(to: path, options: .atomic); status.text = failed == 0 ? "verified" : "failed" }
        catch { status.text = "write failed" }
    }
}
@main final class NativeFitnessApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds); w.rootViewController = FitnessController(); w.makeKeyAndVisible(); window = w
        return true
    }
}
