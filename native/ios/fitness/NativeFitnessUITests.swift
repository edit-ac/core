import XCTest

final class NativeFitnessUITests: XCTestCase {
    func focus(_ app: XCUIApplication, button: XCUIElement, status: XCUIElement, value: String) {
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let ready = NSPredicate(format: "value == %@", value)
        for _ in 0..<3 {
            app.activate()
            button.press(forDuration: 0.1)
            if ready.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: status)], timeout: 5) == .completed { return }
        }
        XCTFail("UIKit did not acknowledge an actual foreground focus action")
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
        focus(app, button: app.buttons["workload-focus"], status: status, value: "keyboard-ready")
        awaitValue("keyboard-ready")
        var dispatches: [[String: Any]] = []
        for (i, letter) in "abcdefghijkl".enumerated() {
            let key = app.keys[String(letter)]; XCTAssertTrue(key.waitForExistence(timeout: 5)); XCTAssertTrue(key.isHittable)
            // The retained Long failure lost its second 100ms touch before its
            // text-delegate callback. Use one deliberate OS press, never replay a
            // lost edit or insert through a host-control shortcut.
            let before = ProcessInfo.processInfo.systemUptime
            key.press(forDuration: 0.2); awaitValue("samples-\(i + 1)")
            dispatches.append(["key": String(letter), "before": before, "after": ProcessInfo.processInfo.systemUptime])
        }
        let data = try JSONSerialization.data(withJSONObject: ["client": "XCTest OS workload key press", "name": name,
            "pressDurationSeconds": 0.2, "clock": "ProcessInfo.systemUptime; no cross-process join", "dispatches": dispatches], options: [.sortedKeys])
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
        focus(app, button: app.buttons["focus-append"], status: app.staticTexts["scenario-status"], value: "ascii-ready")
        // A fresh OS image presents its swipe-typing tutorial above the keys.
        let tutorial = app.buttons["Continue"]
        if tutorial.waitForExistence(timeout: 5) {
            // Dispatch to the actual system button, not its StaticText child.
            XCTAssertTrue(tutorial.isHittable)
            tutorial.press(forDuration: 0.1)
            XCTAssertTrue(tutorial.waitForNonExistence(timeout: 10))
            // Continue dismisses system UI, which is not proof that the text
            // service is rebound to our editor. Request fresh UIKit focus
            // before measuring the first actual key; never retry a lost key.
            focus(app, button: app.buttons["focus-append"], status: app.staticTexts["scenario-status"], value: "ascii-ready")
        }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "value == %@", "ascii-ready")
        let status = app.staticTexts["scenario-status"]
        XCTAssertTrue(ready.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: status)], timeout: 15) == .completed)
        var driverSamples: [[String: Any]] = []
        var prefix = initial
        for letter in "abcdefghijkl" {
            let key = app.keys[String(letter)]
            XCTAssertTrue(key.waitForExistence(timeout: 5)); XCTAssertTrue(key.isHittable)
            let before = ProcessInfo.processInfo.systemUptime
            key.press(forDuration: 0.1); prefix += String(letter)
            let committed = NSPredicate(format: "value == %@", prefix)
            XCTAssertTrue(committed.evaluate(with: editor) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: committed, object: editor)], timeout: 10) == .completed)
            let observed = editor.value as? String ?? ""
            XCTAssertEqual(observed, prefix)
            driverSamples.append(["before": before, "after": ProcessInfo.processInfo.systemUptime, "value": observed])
        }
        XCTAssertEqual(editor.value as? String, initial + "abcdefghijkl")
        XCTAssertTrue(editor.frame.width > 0 && editor.frame.height > 0)
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "OS keyboard and accessibility value"; before.lifetime = .keepAlways; add(before)
        app.buttons["verify-source"].tap()
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
        editor.tap()
        // A fresh OS image presents its swipe-typing tutorial above the keys.
        let tutorial = app.staticTexts["Continue"]
        if tutorial.waitForExistence(timeout: 5) { tutorial.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "value == %@", "pinyin-ready")
        XCTAssertTrue(ready.evaluate(with: status) || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: status)], timeout: 15) == .completed)
        var keyObservations: [[String: Any]] = []
        for letter in ["n", "i"] {
            let key = app.keys[letter]; XCTAssertTrue(key.waitForExistence(timeout: 5)); XCTAssertTrue(key.isHittable)
            key.press(forDuration: 0.1)
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
            let key = app.keys[letter]; XCTAssertTrue(key.isHittable); key.press(forDuration: 0.1)
            awaitStatus("composing"); XCTAssertEqual(source.label, expected)
            keyObservations.append(["key": letter, "source": source.label, "projected": editor.value as? String ?? "", "at": ProcessInfo.processInfo.systemUptime])
        }
        capture("OS Pinyin composition before host cancel")
        app.buttons["cancel-composition"].tap(); awaitStatus("cancelled")
        XCTAssertEqual(source.label, expected); XCTAssertEqual(editor.value as? String, expected)
        app.buttons["verify-source"].tap(); awaitStatus("verified")
        XCTAssertEqual(editor.value as? String, expected)
        let record: [String: Any] = ["client": "XCTest OS Pinyin candidate accessibility query/action", "candidate": geometry,
            "keys": keyObservations, "committed": source.label, "value": editor.value as? String ?? "", "status": status.label,
            "candidateDispatchBefore": before, "candidateAXAfter": after, "driverClock": "ProcessInfo.systemUptime; independent clock, no cross-process timestamp join",
            "cancelAction": "native host cancels actual OS marked text", "screenReader": "not observed"]
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "cjk-accessibility-observation"; attachment.lifetime = .keepAlways; add(attachment)
    }

}
