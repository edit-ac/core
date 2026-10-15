import UIKit
import Darwin

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

// Observe actual OS UITextInput calls after the outermost native mutation. Marked
// text belongs to UIKit; only a completed append crosses the public Rust boundary.
final class FitnessTextView: UITextView {
    var cjk = false
    var changed: ((String) -> Void)?
    var depth = 0
    override var textInputMode: UITextInputMode? {
        let language = cjk ? "zh-Hans" : "en-US"
        return UITextInputMode.activeInputModes.first { $0.primaryLanguage == language } ?? super.textInputMode
    }
    func mutation(_ kind: String, _ body: () -> Void) {
        depth += 1; body(); depth -= 1
        if depth == 0 && cjk { changed?(kind) }
    }
    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        mutation("setMarkedText") { super.setMarkedText(markedText, selectedRange: selectedRange) }
    }
    override func setAttributedMarkedText(_ markedText: NSAttributedString?, selectedRange: NSRange) {
        mutation("setAttributedMarkedText") { super.setAttributedMarkedText(markedText, selectedRange: selectedRange) }
    }
    override func replace(_ range: UITextRange, withText text: String) {
        mutation("replace") { super.replace(range, withText: text) }
    }
    override func unmarkText() { mutation("unmarkText") { super.unmarkText() } }
    override func insertText(_ text: String) { mutation("insertText") { super.insertText(text) } }
    override func deleteBackward() { mutation("deleteBackward") { super.deleteBackward() } }
}

// Deliberately one bounded owning scenario, not the iOS SDK. Rust commits keyboard
// edits; the native control owns marked text only. Unsupported edits are rejected.
final class FitnessController: UIViewController, UITextViewDelegate {
    let editor = FitnessTextView(usingTextLayoutManager: false)
    let status = UILabel()
    var engine: NativeEngine!
    let cjk = ProcessInfo.processInfo.arguments.contains("--cjk")
    let committedLabel = UILabel()
    var compositionEvents: [[String: Any]] = []
    var cancellation: [String: Any] = [:]
    var suppressNative = false
    var finished = false
    var initial = ""
    var typed = ""
    var samples: [[String: Any]] = []
    var pending: [[String: Any]] = []
    var frameTrace: [[String: Double]] = []
    var keyboards: [[String: Any]] = []
    var errors: [String] = []
    var attempts: [[String: Any]] = []
    var focusRequests = 0
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
        editor.autocapitalizationType = .none
        editor.smartQuotesType = .no; editor.smartDashesType = .no
        editor.cjk = cjk
        editor.keyboardType = .default
        editor.changed = { [weak self] kind in self?.nativeMutation(kind) }
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
        if cjk {
            focus.frame = CGRect(x: 20, y: 50, width: 170, height: 40); focus.setTitle("Focus Pinyin", for: .normal)
            committedLabel.frame = CGRect(x: 20, y: 400, width: 350, height: 25)
            committedLabel.accessibilityIdentifier = "committed-source"; view.addSubview(committedLabel)
            let cancel = UIButton(type: .system); cancel.frame = CGRect(x: 200, y: 50, width: 170, height: 40)
            cancel.setTitle("Cancel native composition", for: .normal); cancel.accessibilityIdentifier = "cancel-composition"
            cancel.addTarget(self, action: #selector(cancelComposition), for: .touchUpInside); view.addSubview(cancel)
        }
        do {
            let data = try Data(contentsOf: Bundle.main.url(forResource: "bounded-abi", withExtension: "json")!)
            fixture = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            initial = fixture["initialText"] as! String
            engine = try NativeEngine.create(inputJson: fitnessJSON(["profile": fixture["profile"]!, "epoch": fixture["epoch"]!,
                "documentId": "a8000000-0000-4000-8000-000000000030", "nodes": [["text": initial]]]))
            editor.text = initial
            committedLabel.text = initial
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
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Keep controls below the system status/Dynamic Island hit region.
        // The former full-width focus button straddled that region, allowing
        // XCTest to dispatch a tap without invoking our focus action.
        let top = max(80, view.safeAreaInsets.top + 8)
        let width = min(350, view.bounds.width - 40)
        editor.frame = CGRect(x: 20, y: top + 50, width: width, height: 300)
        committedLabel.frame = CGRect(x: 20, y: top + 355, width: width, height: 25)
        status.frame = CGRect(x: 20, y: top + 385, width: width, height: 40)
        for button in view.subviews.compactMap({ $0 as? UIButton }) {
            switch button.accessibilityIdentifier {
            case "focus-append": button.frame = CGRect(x: 20, y: top, width: 170, height: 40)
            case "cancel-composition": button.frame = CGRect(x: 200, y: top, width: 170, height: 40)
            case "verify-source": button.frame = CGRect(x: 20, y: top + 435, width: width, height: 40)
            default: break
            }
        }
    }
    @objc func focusAppend() {
        focusRequests += 1
        partial()
        // Rebind after first-run keyboard UI as well as a language relaunch.
        // The swipe tutorial can leave visible keys and acknowledged focus
        // without a live input session after Continue is dismissed.
        status.accessibilityValue = "focus-pending"
        editor.resignFirstResponder()
        editor.becomeFirstResponder()
        editor.reloadInputViews()
        editor.selectedRange = NSRange(location: editor.textStorage.length, length: 0)
        if cjk { status.accessibilityValue = editor.isFirstResponder && editor.textInputMode?.primaryLanguage == "zh-Hans" ? "pinyin-ready" : "focus failed" }
        partial()
    }
    func textViewDidBeginEditing(_ textView: UITextView) {
        // The driver enters the actual text control. Observe UIKit granting
        // focus rather than inferring readiness from a focus-button tap.
        // UIKit positions the caret for the tap after didBeginEditing returns.
        // Install this append-only scenario's selection after that native turn,
        // then expose readiness; otherwise Pinyin can compose before the seed.
        DispatchQueue.main.async { [weak self, weak textView] in
            guard let self = self, let textView = textView else { return }
            textView.selectedRange = NSRange(location: textView.textStorage.length, length: 0)
            self.status.accessibilityValue = textView.isFirstResponder && textView.textInputMode?.primaryLanguage == (self.cjk ? "zh-Hans" : "en-US") ? (self.cjk ? "pinyin-ready" : "ascii-ready") : "focus failed"
            self.partial()
        }
    }
    func partial() {
        let value: [String: Any] = ["errors": errors, "attempts": attempts, "typed": typed, "focusRequests": focusRequests,
            "firstResponder": editor.isFirstResponder, "inputMode": editor.textInputMode?.primaryLanguage ?? "unavailable",
            "committed": (try? text(engine)) ?? "unavailable", "projected": editor.text ?? "",
            "selectionUtf16": editor.selectedRange.location, "samples": samples, "frames": frameTrace, "compositionEvents": compositionEvents, "cancellation": cancellation, "inputModes": UITextInputMode.activeInputModes.map { $0.primaryLanguage ?? "unknown" }]
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(cjk ? "cjk-partial.json" : "partial.json")
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
            s["firstResponderAtFrame"] = editor.isFirstResponder
            samples.append(s)
        }
        pending.removeAll()
        display?.isPaused = true
        partial()
    }
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
        if cjk || composing { return true }
        let start = CACurrentMediaTime()
        attempts.append(["rangeUtf16": range.location, "removedUtf16": range.length, "replacement": replacement])
        do {
            try expect(textView.isFirstResponder, "native keyboard target owns focus before commit")
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
            try expect(textView.isFirstResponder, "bounded projection preserves native keyboard focus")
            typed += replacement
            pending.append(["inputAt": start, "engineDoneAt": engineDone, "projectionDoneAt": CACurrentMediaTime(),
                "rangeUtf16": range.location, "replacementUtf16": replacement.utf16.count,
                "committedUtf16": next.utf16.count, "thermal": ProcessInfo.processInfo.thermalState.rawValue,
                "firstResponderBeforeAndAfterCommit": textView.isFirstResponder,
                "inputMode": textView.textInputMode?.primaryLanguage ?? "unavailable"])
            display?.isPaused = false
        } catch { errors.append(String(describing: error)); status.text = "input failed"; partial() }
        return false
    }
    func textViewDidChange(_ textView: UITextView) {
        guard cjk && !suppressNative else { return }
        // UIKit can dispatch attributed input through its internal text service.
        // Observe the public delegate after its outer native mutation settles.
        DispatchQueue.main.async { [weak self] in self?.nativeMutation("textViewDidChange") }
    }
    func nativeMutation(_ kind: String) {
        guard cjk && !suppressNative && !finished else { return }
        let start = CACurrentMediaTime()
        do {
            let before = try text(engine)
            let marked = editor.markedTextRange
            var event: [String: Any] = ["kind": kind, "at": start, "committedBefore": before,
                "projected": editor.text ?? "", "inputMode": editor.textInputMode?.primaryLanguage ?? "unavailable",
                "marked": marked != nil, "caretRect": rect(editor.caretRect(for: editor.selectedTextRange!.end))]
            if let m = marked { event["markedText"] = editor.text(in: m) ?? ""; event["markedRect"] = rect(editor.firstRect(for: m)) }
            if marked == nil && editor.text != before {
                let projected = editor.text ?? ""
                try expect(projected.hasPrefix(before), "bounded CJK append only")
                let addition = String(projected.dropFirst(before.count))
                try expect(addition == "你" && typed.isEmpty, "fixed CJK candidate only")
                let id = (try decode(engine.read())["visible"] as! [[String: Any]])[0]["id"] as! String
                let anchor = try engine.captureAnchor(input: AnchorInput(node: id, offsetUtf16: UInt32(before.utf16.count), bias: .right))
                defer { try? engine.releaseAnchor(token: anchor) }
                _ = try engine.executeBatch(commandsJson: fitnessJSON(["kind": "editor", "origin": "prf07-os-pinyin", "commands": [["type": "insert", "at": anchor, "text": addition]]]))
                let done = CACurrentMediaTime()
                try expect((try text(engine)) == projected, "CJK commit source oracle")
                typed = addition; committedLabel.text = projected
                pending.append(["inputAt": start, "engineDoneAt": done, "projectionDoneAt": CACurrentMediaTime(),
                    "rangeUtf16": before.utf16.count, "replacementUtf16": addition.utf16.count,
                    "committedUtf16": projected.utf16.count, "thermal": ProcessInfo.processInfo.thermalState.rawValue,
                    "inputMode": editor.textInputMode?.primaryLanguage ?? "unavailable"])
                display?.isPaused = false
            }
            event["committedAfter"] = try text(engine); compositionEvents.append(event)
            status.text = marked != nil ? "composing" : "committed"
        } catch { errors.append(String(describing: error)); editor.text = (try? text(engine)) ?? initial; status.text = "input failed" }
        partial()
    }
    @objc func cancelComposition() {
        do {
            let before = try text(engine)
            try expect(editor.markedTextRange != nil, "cancel must start with OS marked composition")
            cancellation = ["before": before, "projectedBefore": editor.text ?? "", "markedRect": rect(editor.firstRect(for: editor.markedTextRange!)), "at": CACurrentMediaTime()]
            suppressNative = true; editor.unmarkText(); editor.text = before
            editor.selectedRange = NSRange(location: before.utf16.count, length: 0); suppressNative = false
            cancellation["after"] = try text(engine); cancellation["projectedAfter"] = editor.text ?? ""
            cancellation["markedAfter"] = editor.markedTextRange != nil
            status.text = "cancelled"
        } catch { suppressNative = false; errors.append(String(describing: error)); status.text = "cancel failed" }
        partial()
    }
    func verifyCJK() {
        finished = true
        var cases: [[String: Any]] = []
        func check(_ id: String, _ body: () throws -> [String: Any]) {
            do { cases.append(["id": id, "state": "passed", "observed": try body()]) }
            catch { cases.append(["id": id, "state": "failed", "error": String(describing: error)]) }
        }
        let expected = initial + "你"
        check("os-pinyin-marked-isolation") {
            let marked = compositionEvents.filter { $0["marked"] as? Bool == true }
            try expect(!marked.isEmpty && marked.allSatisfy { $0["inputMode"] as? String == "zh-Hans" && $0["committedBefore"] as? String == $0["committedAfter"] as? String }, "OS Pinyin provisional source isolation")
            try expect(marked.contains { $0["committedBefore"] as? String == initial } && marked.contains { $0["committedBefore"] as? String == expected }, "both commit and cancel compositions observed")
            return ["events": marked.count, "inputMode": editor.textInputMode?.primaryLanguage ?? "unavailable"]
        }
        check("os-candidate-committed-source") {
            try expect(errors.isEmpty && typed == "你" && (try text(engine)) == expected && editor.text == expected, "selected candidate commits exact source once")
            return ["typed": typed, "focusRequests": focusRequests, "committed": try text(engine), "selectionUtf16": editor.selectedRange.location]
        }
        check("os-composition-cancellation") {
            try expect(cancellation["before"] as? String == expected && cancellation["after"] as? String == expected && cancellation["projectedAfter"] as? String == expected && cancellation["markedAfter"] as? Bool == false, "cancel preserves committed source")
            return cancellation
        }
        check("cjk-response-frame-and-caret") {
            try expect(samples.count == 1 && pending.isEmpty && frameTrace.count == 1, "candidate commit display callback")
            return ["samples": samples.count, "frameCallbacks": frameTrace.count]
        }
        check("cjk-checkpoint-reopen") {
            let cp = try engine.checkpoint(); var restore = try decode(cp.metadataJson)
            restore["expected"] = try decode(engine.read())["identity"]!; restore["journal"] = [Any]()
            let reopened = try NativeEngine.restore(inputJson: fitnessJSON(restore), bytes: cp.bytes); defer { try? reopened.dispose() }
            try expect((try text(reopened)) == expected, "CJK checkpoint exact source")
            return ["text": try text(reopened), "checkpointBytes": cp.bytes.count]
        }
        check("cjk-disposal") {
            try engine.dispose(); display?.invalidate(); display = nil
            if let token = keyboardToken { NotificationCenter.default.removeObserver(token); keyboardToken = nil }
            do { _ = try engine.read(); throw CheckFailure(message: "disposed read succeeded") }
            catch let e as NativeError { guard case .Disposed = e else { throw e } }
            return ["displayLinkInvalidated": display == nil, "keyboardObserverRemoved": keyboardToken == nil]
        }
        let failed = cases.filter { $0["state"] as? String == "failed" }.count
        let record: [String: Any] = ["version": 1, "qualification": "unqualified", "cases": cases,
            "counts": ["executed": cases.count, "passed": cases.count-failed, "failed": failed, "skipped": 0],
            "samples": samples, "frames": frameTrace, "keyboards": keyboards, "errors": errors, "compositionEvents": compositionEvents,
            "host": ["system": UIDevice.current.systemVersion, "physical": false, "locale": Locale.current.identifier,
                "thermalStart": thermalStart, "thermalEnd": ProcessInfo.processInfo.thermalState.rawValue,
                "inputModes": UITextInputMode.activeInputModes.map { $0.primaryLanguage ?? "unknown" }],
            "gaps": ["single Pinyin candidate and host cancellation only", "callback is not compositor paint", "one commit below 100-sample tail bar", "XCTest accessibility is not VoiceOver exploration", "not Task/Long or full SDK qualification"]]
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("cjk-result.json")
        do { try Data(fitnessJSON(record).utf8).write(to: path, options: .atomic); status.text = failed == 0 ? "verified" : "failed" }
        catch { status.text = "write failed" }
    }
    @objc func verify() {
        if cjk { verifyCJK(); return }
        var cases: [[String: Any]] = []
        func check(_ id: String, _ block: () throws -> [String: Any]) {
            do { cases.append(["id": id, "state": "passed", "observed": try block()]) }
            catch { cases.append(["id": id, "state": "failed", "error": String(describing: error)]) }
        }
        check("os-keyboard-committed-source") {
            try expect(errors.isEmpty && typed == "abcdefghijkl" && (try text(engine)) == initial + typed && editor.text == initial + typed, "OS key edits equal native source")
            try expect(!keyboards.isEmpty, "actual keyboard visibility notification")
            return ["typed": typed, "focusRequests": focusRequests, "committed": try text(engine), "selectionUtf16": editor.selectedRange.location]
        }
        check("response-frame-and-caret") {
            try expect(samples.count == 12 && pending.isEmpty && frameTrace.count == 12, "all twelve keyboard edits observed by native display link")
            for s in samples {
                try expect(s["firstResponderBeforeAndAfterCommit"] as? Bool == true && s["firstResponderAtFrame"] as? Bool == true, "continuous native keyboard focus through projection and display callback")
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
        let w = UIWindow(frame: UIScreen.main.bounds); w.rootViewController = ProcessInfo.processInfo.arguments.contains("--workload") ? WorkloadController() : FitnessController(); w.makeKeyAndVisible(); window = w
        return true
    }
}

// The same frozen corpus as the browser producer, restored by the real native
// engine. Plain-text TextKit projection isolates the OS text-service envelope;
// this does not claim full mixed-block native renderer qualification.
final class WorkloadController: UIViewController, UITextViewDelegate {
    let editor = FitnessTextView(usingTextLayoutManager: false)
    let status = UILabel()
    var engine: NativeEngine!
    var document: [String: Any] = [:]
    var samples: [[String: Any]] = []
    var pending: [String: Any]?
    var display: CADisplayLink?
    var errors: [String] = []
    var typed = ""
    var initial = ""
    var nodeID = ""
    var nodeOffset = 0
    var targetOffset = 0
    var originalTarget = ""
    var resources: [[String: Any]] = []
    var setup: [String: Any] = [:]
    var attempts: [[String: Any]] = []
    var focusRequests = 0
    func partial() {
        let value: [String: Any] = ["name": name, "setup": setup, "attempts": attempts,
            "samples": samples, "resources": resources, "typed": typed, "focusRequests": focusRequests, "errors": errors,
            "selectionUtf16": editor.selectedRange.location, "projectedUtf16": editor.textStorage.length,
            "firstResponder": editor.isFirstResponder, "inputMode": editor.textInputMode?.primaryLanguage ?? "unavailable"]
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name + "-partial.json")
        if let bytes = try? fitnessJSON(value) { try? Data(bytes.utf8).write(to: url, options: .atomic) }
    }
    let name = ProcessInfo.processInfo.arguments.last!
    func memory(_ phase: String) -> [String: Any] {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return ["phase": phase, "at": CACurrentMediaTime(), "status": result,
            "residentBytes": info.resident_size, "virtualBytes": info.virtual_size,
            "scope": "sampled task resident/virtual bytes; not peak footprint or plateau"]
    }
    func blocks(_ snapshot: [String: Any]) -> [[String: Any]] {
        (snapshot["visible"] as! [[String: Any]]).filter { $0["kind"] as? String == "block" }
    }
    func nodeText(_ node: [String: Any]) -> String {
        (node["runs"] as! [[String: Any]]).map { $0["text"] as! String }.joined()
    }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        editor.frame = CGRect(x: 20, y: 80, width: view.bounds.width - 40, height: 260)
        editor.accessibilityIdentifier = "workload-editor"
        editor.autocorrectionType = .no; editor.spellCheckingType = .no; editor.autocapitalizationType = .none
        editor.smartQuotesType = .no; editor.smartDashesType = .no; editor.font = .systemFont(ofSize: 16)
        editor.delegate = self
        status.accessibilityIdentifier = "workload-status"; status.text = "preparing"
        let button = UIButton(type: .system); button.accessibilityIdentifier = "workload-verify"
        button.setTitle("Verify workload", for: .normal); button.addTarget(self, action: #selector(verify), for: .touchUpInside)
        let focus = UIButton(type: .system); focus.accessibilityIdentifier = "workload-focus"
        focus.setTitle("Focus workload", for: .normal); focus.addTarget(self, action: #selector(focusWorkload), for: .touchUpInside)
        view.addSubview(editor); view.addSubview(status); view.addSubview(button); view.addSubview(focus)
        do {
            resources.append(memory("before-restore"))
            let start = CACurrentMediaTime()
            func load(_ suffix: String) throws -> [String: Any] {
                try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.main.url(forResource: name + suffix, withExtension: "json")!)) as! [String: Any]
            }
            document = try load("")
            let frozen = try load(".native-checkpoint")
            var cp = frozen["checkpoint"] as! [String: Any]
            let bytes = (cp.removeValue(forKey: "bytes") as! [Int]).map { UInt8($0) }
            cp["expected"] = frozen["identity"]!; cp["journal"] = [Any]()
            engine = try NativeEngine.restore(inputJson: fitnessJSON(cp), bytes: Data(bytes))
            let restored = CACurrentMediaTime()
            let snapshot = try decode(engine.read())
            try expect(try fitnessJSON(snapshot) == fitnessJSON(load(".native-snapshot")), "full restored snapshot equals native producer")
            let nodes = blocks(snapshot)
            let fixtureBlocks = document["blocks"] as! [[String: Any]]
            try expect(nodes.count == fixtureBlocks.count, "full corpus block count")
            for (node, expected) in zip(nodes, fixtureBlocks) {
                try expect(nodeText(node) == nodeText(expected), "independent generated text oracle")
            }
            initial = nodes.map(nodeText).joined(separator: "\n")
            nodeID = nodes.last!["id"] as! String
            let units = Array(nodeText(nodes.last!).utf16)
            nodeOffset = units.indices.reversed().first { (65...90).contains(units[$0]) || (97...122).contains(units[$0]) }!
            targetOffset = initial.utf16.count - units.count + nodeOffset
            originalTarget = String(UnicodeScalar(units[nodeOffset])!)
            editor.text = initial; editor.selectedRange = NSRange(location: initial.utf16.count, length: 0)
            editor.layoutManager.ensureLayout(for: editor.textContainer)
            setup = ["restoreStartAt": start, "restoredAt": restored, "projectionLayoutDoneAt": CACurrentMediaTime(),
                "checkpointBytes": bytes.count, "blocks": nodes.count, "textUtf8Bytes": nodes.map(nodeText).reduce(0) { $0 + $1.utf8.count },
                "textUtf16Units": nodes.map(nodeText).reduce(0) { $0 + $1.utf16.count }, "projectedUtf16Units": initial.utf16.count,
                "fullSnapshotRestored": true, "targetOffsetUtf16": targetOffset, "nodeOffsetUtf16": nodeOffset, "originalTarget": originalTarget]
            resources.append(memory("after-projection-layout")); status.text = "ready"
        } catch { errors.append(String(describing: error)); status.text = "failed" }
        display = CADisplayLink(target: self, selector: #selector(frame(_:))); display?.add(to: .main, forMode: .common); display?.isPaused = true
        partial()
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = max(80, view.safeAreaInsets.top + 8)
        editor.frame = CGRect(x: 20, y: top, width: view.bounds.width - 40, height: 260)
        status.frame = CGRect(x: 20, y: top + 265, width: 170, height: 40)
        for button in view.subviews.compactMap({ $0 as? UIButton }) {
            button.frame = button.accessibilityIdentifier == "workload-focus"
                ? CGRect(x: 200, y: top + 265, width: 170, height: 40)
                : CGRect(x: 20, y: top + 310, width: 350, height: 40)
        }
    }
    @objc func focusWorkload() {
        focusRequests += 1
        partial()
        // An explicit OS button action requests UIKit focus. A tap in a huge
        // scrolled text surface does not prove a text-service session exists.
        let alreadyFocused = editor.isFirstResponder
        editor.becomeFirstResponder()
        if alreadyFocused { textViewDidBeginEditing(editor) }
        partial()
    }
    func textViewDidBeginEditing(_ textView: UITextView) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.editor.selectedRange = NSRange(location: self.targetOffset, length: 1)
            self.editor.scrollRangeToVisible(self.editor.selectedRange)
            self.status.accessibilityValue = self.editor.isFirstResponder ? "keyboard-ready" : "focus-failed"
            self.partial()
        }
    }
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
        let start = CACurrentMediaTime()
        attempts.append(["rangeUtf16": range.location, "removedUtf16": range.length, "replacement": replacement, "pending": pending != nil])
        do {
            try expect(pending == nil && textView.isFirstResponder && range.length == 1 && range.location == targetOffset && replacement.utf16.count == 1, "single OS overwrite with continuous focus at fixed corpus bound")
            let anchor = try engine.captureAnchor(input: AnchorInput(node: nodeID, offsetUtf16: UInt32(nodeOffset), bias: .right))
            let anchorDone = CACurrentMediaTime()
            let focus = try engine.captureAnchor(input: AnchorInput(node: nodeID, offsetUtf16: UInt32(nodeOffset + 1), bias: .left))
            let focusDone = CACurrentMediaTime()
            defer { try? engine.releaseAnchor(token: anchor); try? engine.releaseAnchor(token: focus) }
            let commands = try fitnessJSON(["kind": "editor", "origin": "prf07-workload-os-keyboard", "commands": [["type": "replace", "range": ["anchor": anchor, "focus": focus], "text": replacement]]])
            let batchStart = CACurrentMediaTime()
            let result = try engine.executeBatch(commandsJson: commands)
            let done = CACurrentMediaTime()
            let nativeResult = try decode(result.resultJson)
            let trace = nativeResult["fitnessTrace"] as! [String: Any]
            let patch = try decode(result.patchJson)
            let changed = patch["nodes"] as! [[String: Any]]
            try expect(changed.count == 1 && (changed[0]["node"] as! [String: Any])["id"] as? String == nodeID, "one changed block in full corpus")
            let decoded = CACurrentMediaTime()
            textView.textStorage.replaceCharacters(in: range, with: replacement)
            textView.selectedRange = NSRange(location: targetOffset, length: 1); textView.scrollRangeToVisible(textView.selectedRange)
            typed += replacement
            pending = ["inputAt": start, "engineDoneAt": done, "projectionDoneAt": CACurrentMediaTime(),
                "anchorDoneAt": anchorDone, "focusDoneAt": focusDone, "batchStartAt": batchStart,
                "decodedAt": decoded, "rustTrace": trace,
                "rangeUtf16": range.location, "replacementUtf16": 1, "removedUtf16": 1, "changedBlocks": changed.count,
                "thermal": ProcessInfo.processInfo.thermalState.rawValue, "firstResponder": textView.isFirstResponder, "inputMode": textView.textInputMode?.primaryLanguage ?? "unavailable"]
            display?.isPaused = false
        } catch { errors.append(String(describing: error)); status.text = "failed"; partial() }
        return false
    }
    @objc func frame(_ link: CADisplayLink) {
        guard var sample = pending else { return }
        sample["layoutStartAt"] = CACurrentMediaTime()
        editor.layoutManager.ensureLayout(for: editor.textContainer)
        sample["layoutDoneAt"] = CACurrentMediaTime(); sample["displayTimestamp"] = link.timestamp; sample["targetTimestamp"] = link.targetTimestamp
        sample["caretRect"] = rect(editor.caretRect(for: editor.selectedTextRange!.end)); sample["firstResponderAtFrame"] = editor.isFirstResponder
        samples.append(sample); resources.append(memory("input-\(samples.count)")); pending = nil; display?.isPaused = true
        status.accessibilityValue = "samples-\(samples.count)"
        partial()
    }
    @objc func verify() {
        var cases: [[String: Any]] = []
        func check(_ id: String, _ body: () throws -> Void) {
            do { try body(); cases.append(["id": id, "state": "passed"]) }
            catch { cases.append(["id": id, "state": "failed", "error": String(describing: error)]) }
        }
        check("full-corpus-os-keyboard") {
            try expect(errors.isEmpty && typed == "abcdefghijkl" && samples.count == 12 && pending == nil, "twelve real keyboard callbacks")
            let snapshot = try decode(engine.read()), nodes = blocks(snapshot), expected = document["blocks"] as! [[String: Any]]
            for (i, node) in nodes.enumerated() {
                let original = nodeText(expected[i]) as NSString
                let wanted = i == nodes.count - 1 ? original.replacingCharacters(in: NSRange(location: nodeOffset, length: 1), with: "l") : original as String
                try expect(nodeText(node) == wanted, "all generated text preserved outside one-character overwrite")
            }
            try expect(editor.text == (initial as NSString).replacingCharacters(in: NSRange(location: targetOffset, length: 1), with: "l"), "full native projection oracle")
        }
        check("exact-checkpoint-reopen") {
            let before = try decode(engine.read()), cp = try engine.checkpoint()
            var metadata = try decode(cp.metadataJson); metadata["expected"] = before["identity"]!; metadata["journal"] = [Any]()
            let restored = try NativeEngine.restore(inputJson: fitnessJSON(metadata), bytes: cp.bytes)
            defer { try? restored.dispose() }
            let reopened = try decode(restored.read())
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            for (suffix, value) in [("final-snapshot", before), ("reopened-snapshot", reopened)] {
                try Data(fitnessJSON(value).utf8).write(to: directory.appendingPathComponent(name + "-" + suffix + ".json"), options: .atomic)
            }
            try cp.bytes.write(to: directory.appendingPathComponent(name + "-checkpoint.bin"), options: .atomic)
            try Data(cp.metadataJson.utf8).write(to: directory.appendingPathComponent(name + "-checkpoint-metadata.json"), options: .atomic)
            // Revision and last-change diagnostics are session-local read metadata,
            // not committed document state. Preserve raw snapshots and compare
            // every remaining field, including identity, spans and recovery.
            func committed(_ value: [String: Any]) -> [String: Any] {
                var result = value
                for key in ["revision", "changedNodes", "touchedRanges"] { result.removeValue(forKey: key) }
                return result
            }
            try expect(try fitnessJSON(committed(reopened)) == fitnessJSON(committed(before)), "full committed mixed snapshot checkpoint equality")
        }
        check("resources-and-disposal") {
            resources.append(memory("before-disposal")); try engine.dispose(); display?.invalidate(); display = nil
            resources.append(memory("after-disposal"))
            try expect(resources.allSatisfy { ($0["status"] as? Int32) == KERN_SUCCESS && ($0["residentBytes"] as? UInt64 ?? 0) > 0 }, "executed task memory observations")
        }
        let failed = cases.filter { $0["state"] as? String == "failed" }.count
        let record: [String: Any] = ["version": 1, "name": name, "qualification": "unqualified", "setup": setup, "cases": cases,
            "counts": ["executed": cases.count, "passed": cases.count - failed, "failed": failed, "skipped": 0],
            "samples": samples, "resources": resources, "errors": errors, "typed": typed, "focusRequests": focusRequests,
            "host": ["system": UIDevice.current.systemVersion, "physical": false, "refreshMaximum": UIScreen.main.maximumFramesPerSecond],
            "gaps": ["plain-text projection; mixed-block native renderer not qualified", "callback is not compositor", "12 samples below 100-sample tail minimum", "sampled resident memory is not peak or plateau", "no VoiceOver or physical thermal claim"]]
        do {
            let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name + "-result.json")
            try Data(fitnessJSON(record).utf8).write(to: url, options: .atomic); status.text = failed == 0 ? "verified" : "failed"
        } catch { status.text = "write failed" }
    }
}
