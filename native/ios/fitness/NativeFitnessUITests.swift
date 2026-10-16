import XCTest

final class NativeFitnessUITests: XCTestCase {
    func dismissKeyboardTutorial(_ app: XCUIApplication) throws -> Bool {
        let tutorial = app.buttons["Continue"]
        guard tutorial.waitForExistence(timeout: 5) else { return false }
        XCTAssertTrue(tutorial.isHittable)
        let r = tutorial.frame, window = app.windows.firstMatch.frame
        XCTAssertTrue(window.contains(r)); XCTAssertGreaterThan(r.width, 0); XCTAssertGreaterThan(r.height, 0)
        // Ask XCTest to resolve the actual OS button's hit target; its frame
        // can extend beyond the keyboard's accessibility rectangle.
        let before = ProcessInfo.processInfo.systemUptime
        tutorial.tap()
        let record: [String: Any] = ["action": "single XCTest-resolved keyboard tutorial button tap",
            "frame": ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height],
            "point": ["x": r.midX, "y": r.midY], "before": before, "after": ProcessInfo.processInfo.systemUptime]
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "keyboard tutorial screen dispatch"; attachment.lifetime = .keepAlways; add(attachment)
        XCTAssertTrue(tutorial.waitForNonExistence(timeout: 10))
        return true
    }
    func focus(_ app: XCUIApplication, button: XCUIElement, status: XCUIElement, value: String) throws {
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let ready = NSPredicate(format: "value == %@", value)
        let settled = NSPredicate(format: "value == %@ OR value BEGINSWITH %@", value, "input-mode:")
        var transitions: [[String: Any]] = []
        var switchesRemaining = 6
        for attempt in 1...3 {
            // Retry only pre-input focus. A mode change may dismiss the software
            // keyboard after UIKit has reported the selected language ready.
            app.activate(); button.tap()
            guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else { continue }
            _ = try dismissKeyboardTutorial(app)
            guard settled.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: status)], timeout: 5) == .completed else { continue }
            while !ready.evaluate(with: status) && switchesRemaining > 0 {
                let previous = status.value as? String ?? "unavailable"
                let next = app.buttons["Next keyboard"]
                guard next.waitForExistence(timeout: 5) && next.isHittable else { break }
                let before = ProcessInfo.processInfo.systemUptime
                next.tap(); switchesRemaining -= 1
                let changed = NSPredicate(format: "value != %@", previous)
                guard XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: changed, object: status)], timeout: 10) == .completed else { break }
                transitions.append(["before": before, "after": ProcessInfo.processInfo.systemUptime,
                    "focusAttempt": attempt, "previous": previous, "observed": status.value as? String ?? "unavailable"])
                // A newly selected language can present its own first-use sheet.
                _ = try dismissKeyboardTutorial(app)
            }
            guard ready.evaluate(with: status) && app.keyboards.firstMatch.waitForExistence(timeout: 10) else { continue }
            if value == "pinyin-ready" {
                let firstKey = app.keys["n"]
                guard firstKey.waitForExistence(timeout: 5) && firstKey.isHittable else { continue }
            }
            let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: transitions, options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
            attachment.name = "actual OS keyboard input-mode transitions"; attachment.lifetime = .keepAlways; add(attachment)
            return
        }
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: transitions, options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
        attachment.name = "failed pre-input focus and mode transitions"; attachment.lifetime = .keepAlways; add(attachment)
        XCTFail("Actual selected OS input mode and keyboard did not acknowledge a bounded focus action")
        throw NSError(domain: "NativeFitnessFocus", code: 1)
    }

    func workload(_ name: String) throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ac.edit.nativefitness")
        app.launchArguments = ["--workload", name]; app.launch()
        addTeardownBlock { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name + " workload"; a.lifetime = .keepAlways; self.add(a) }
        let editor = app.textViews["workload-editor"], status = app.staticTexts["workload-status"]
        XCTAssertTrue(editor.waitForExistence(timeout: 60))
        func awaitValue(_ value: String) {
            let p = NSPredicate(format: "value == %@", value)
            XCTAssertTrue(p.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: p, object: status)], timeout: 30) == .completed)
        }
        XCTAssertEqual(status.label, "ready")
        try focus(app, button: app.buttons["workload-focus"], status: status, value: "keyboard-ready")
        awaitValue("keyboard-ready")
        var dispatches: [[String: Any]] = []
        for (i, letter) in "abcdefghijkl".enumerated() {
            // KeyboardEvents is the OS hardware-key path; it can hide the
            // software keys while the text control retains native input focus.
            // A visible software-key lookup is not its delivery acknowledgment.
            // Require each actual native sample instead, with no fallback/replay.
            let keyboardVisible = app.keyboards.firstMatch.exists
            let before = ProcessInfo.processInfo.systemUptime
            app.typeText(String(letter)); awaitValue("samples-\(i + 1)")
            dispatches.append(["key": String(letter), "softwareKeyboardVisibleBefore": keyboardVisible,
                "before": before, "after": ProcessInfo.processInfo.systemUptime])
        }
        let data = try JSONSerialization.data(withJSONObject: ["client": "XCTest OS workload key press", "name": name,
            "transport": "XCTest application KeyboardEvents.typeText; one dispatch, no replay or setter", "clock": "ProcessInfo.systemUptime; no cross-process join", "dispatches": dispatches], options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name + " OS dispatches"; attachment.lifetime = .keepAlways; add(attachment)
        app.buttons["workload-verify"].tap()
        let p = NSPredicate(format: "label == %@", "verified")
        XCTAssertTrue(p.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: p, object: status)], timeout: 30) == .completed)
    }
    func testTaskWorkload() throws { try workload("Task") }
    func testLongWorkload() throws { try workload("Long") }
    func testKeyboardAccessibilityCancellationAndSource() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ac.edit.nativefitness")
        app.launch()
        addTeardownBlock {
            let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "final ASCII runtime state"; screenshot.lifetime = .keepAlways; self.add(screenshot)
            let tree = XCTAttachment(string: app.debugDescription); tree.name = "final ASCII accessibility tree"; tree.lifetime = .keepAlways; self.add(tree)
        }
        let editor = app.textViews["native-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 30))
        let initial = "A😀éZ"
        XCTAssertEqual(editor.value as? String, initial)
        try focus(app, button: app.buttons["focus-append"], status: app.staticTexts["scenario-status"], value: "ascii-ready")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "value == %@", "ascii-ready")
        let status = app.staticTexts["scenario-status"]
        XCTAssertTrue(ready.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: status)], timeout: 15) == .completed)
        var driverSamples: [[String: Any]] = []
        var prefix = initial
        for letter in "abcdefghijkl" {
            // Hardware-key transport does not require a hittable software key.
            // Admit delivery only through the exact native value/callback path.
            let before = ProcessInfo.processInfo.systemUptime
            app.typeText(String(letter)); prefix += String(letter)
            let committed = NSPredicate(format: "value == %@", prefix)
            XCTAssertTrue(committed.evaluate(with: editor) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: committed, object: editor)], timeout: 10) == .completed)
            let observed = editor.value as? String ?? ""
            XCTAssertEqual(observed, prefix)
            driverSamples.append(["before": before, "after": ProcessInfo.processInfo.systemUptime, "value": observed])
        }
        XCTAssertEqual(editor.value as? String, initial + "abcdefghijkl")
        XCTAssertTrue(editor.frame.width > 0 && editor.frame.height > 0)
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "OS keyboard and accessibility value"; before.lifetime = .keepAlways; add(before)
        let verify = app.buttons["verify-source"]
        XCTAssertTrue(verify.isHittable)
        XCTAssertFalse(verify.frame.intersects(app.keyboards.firstMatch.frame), "Verification action must remain outside the live OS keyboard")
        verify.tap()
        let verified = NSPredicate(format: "label == %@", "verified")
        expectation(for: verified, evaluatedWith: status)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(editor.value as? String, initial + "abcdefghijkl")
        let observation: [String: Any] = ["client": "XCTest XCUIElement OS accessibility query/action", "driverClock": "ProcessInfo.systemUptime; independent clock, no cross-process timestamp join", "driverSamples": driverSamples, "value": editor.value as? String ?? "", "frame": ["x": editor.frame.minX, "y": editor.frame.minY, "width": editor.frame.width, "height": editor.frame.height], "keyboardVisible": app.keyboards.firstMatch.exists, "status": status.label, "screenReader": "not observed"]
        let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "accessibility-observation"; attachment.lifetime = .keepAlways; add(attachment)
        print("NATIVE_FITNESS_ACCESSIBILITY " + String(decoding: data, as: UTF8.self))
    }
    func testOSPinyinCandidateCommitAndCancellation() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ac.edit.nativefitness")
        app.launchArguments = ["--cjk"]; app.launch()
        let editor = app.textViews["native-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 30))
        let initial = "A😀éZ", expected = initial + "你"
        let status = app.staticTexts["scenario-status"]
        let source = app.staticTexts["committed-source"]
        func awaitStatus(_ value: String) {
            let predicate = NSPredicate(format: "label == %@", value)
            XCTAssertTrue(predicate.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: status)], timeout: 15) == .completed)
        }
        func capture(_ name: String) {
            let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
            let tree = XCTAttachment(string: app.debugDescription); tree.name = name + " accessibility tree"; tree.lifetime = .keepAlways; add(tree)
        }
        // XCTest aborts after an assertion failure; teardown still retains the
        // actual keyboard/focus/candidate state needed to diagnose that failure.
        addTeardownBlock { capture("final CJK runtime state") }
        try focus(app, button: app.buttons["focus-append"], status: status, value: "pinyin-ready")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "value == %@", "pinyin-ready")
        XCTAssertTrue(ready.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: status)], timeout: 15) == .completed)
        var keyObservations: [[String: Any]] = []
        func tapPinyinKey(_ letter: String) throws {
            let key = app.keys[letter]
            XCTAssertTrue(key.waitForExistence(timeout: 5)); XCTAssertTrue(key.isHittable)
            let frame = key.frame, keyboard = app.keyboards.firstMatch.frame, window = app.windows.firstMatch.frame
            XCTAssertGreaterThan(frame.width, 0); XCTAssertGreaterThan(frame.height, 0)
            XCTAssertTrue(keyboard.contains(frame)); XCTAssertTrue(window.contains(frame))
            // A sustained element press completed without a UITextInput callback.
            // Activate the ordinary software-key touch-up path at its observed
            // center. typeText injects unmarked literals instead of OS Pinyin.
            // Save dispatch evidence before a callback assertion can abort.
            let before = ProcessInfo.processInfo.systemUptime
            key.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let observation: [String: Any] = ["key": letter,
                "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
                "point": ["x": frame.midX, "y": frame.midY],
                "keyboardFrame": ["x": keyboard.minX, "y": keyboard.minY, "width": keyboard.width, "height": keyboard.height],
                "windowFrame": ["x": window.minX, "y": window.minY, "width": window.width, "height": window.height],
                "before": before, "after": ProcessInfo.processInfo.systemUptime,
                "transport": "single ordinary OS touch at observed software-key center; no replay or setter"]
            let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "Pinyin " + letter + " software-key dispatch"; attachment.lifetime = .keepAlways; add(attachment)
        }
        capture("OS Pinyin keyboard before first dispatch")
        for letter in ["n", "i"] {
            try tapPinyinKey(letter)
            awaitStatus("composing"); XCTAssertEqual(source.label, initial)
            keyObservations.append(["key": letter, "source": source.label, "projected": editor.value as? String ?? "", "at": ProcessInfo.processInfo.systemUptime])
        }
        capture("OS Pinyin candidate before commit")
        let candidate = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "你")).firstMatch
        XCTAssertTrue(candidate.waitForExistence(timeout: 10)); XCTAssertTrue(candidate.isHittable)
        let r = candidate.frame
        let geometry: [String: Any] = ["label": candidate.label, "elementType": candidate.elementType.rawValue,
            "frame": ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height], "hittable": candidate.isHittable,
            "keyboardFrame": ["x": app.keyboards.firstMatch.frame.minX, "y": app.keyboards.firstMatch.frame.minY, "width": app.keyboards.firstMatch.frame.width, "height": app.keyboards.firstMatch.frame.height]]
        let before = ProcessInfo.processInfo.systemUptime
        candidate.tap(); awaitStatus("committed")
        // UIKit's attributed text-service delegate settles asynchronously.
        // A transient unmarked status alone does not prove Rust committed.
        let committed = NSPredicate(format: "label == %@", expected)
        XCTAssertTrue(committed.evaluate(with: source) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: committed, object: source)], timeout: 15) == .completed)
        XCTAssertEqual(source.label, expected); XCTAssertEqual(editor.value as? String, expected)
        let after = ProcessInfo.processInfo.systemUptime
        for letter in ["h", "a", "o"] {
            try tapPinyinKey(letter)
            awaitStatus("composing"); XCTAssertEqual(source.label, expected)
            keyObservations.append(["key": letter, "source": source.label, "projected": editor.value as? String ?? "", "at": ProcessInfo.processInfo.systemUptime])
        }
        capture("OS Pinyin composition before host cancel")
        app.buttons["cancel-composition"].tap(); awaitStatus("cancelled")
        XCTAssertEqual(source.label, expected); XCTAssertEqual(editor.value as? String, expected)
        let verify = app.buttons["verify-source"]
        XCTAssertTrue(verify.isHittable)
        XCTAssertFalse(verify.frame.intersects(app.keyboards.firstMatch.frame), "Verification action must remain outside the live OS keyboard")
        verify.tap(); awaitStatus("verified")
        XCTAssertEqual(editor.value as? String, expected)
        let record: [String: Any] = ["client": "XCTest OS Pinyin candidate accessibility query/action", "candidate": geometry,
            "transport": "single ordinary OS touch at observed software-key center; one dispatch per key, no replay or setter",
            "keys": keyObservations, "committed": source.label, "value": editor.value as? String ?? "", "status": status.label,
            "candidateDispatchBefore": before, "candidateAXAfter": after, "driverClock": "ProcessInfo.systemUptime; independent clock, no cross-process timestamp join",
            "cancelAction": "native host cancels actual OS marked text", "screenReader": "not observed"]
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "cjk-accessibility-observation"; attachment.lifetime = .keepAlways; add(attachment)
    }

}
