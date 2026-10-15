import XCTest

final class NativeFitnessUITests: XCTestCase {
    func testKeyboardAccessibilityCancellationAndSource() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ac.edit.nativefitness")
        app.launch()
        let editor = app.textViews["native-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 30))
        let initial = "A😀éZ"
        XCTAssertEqual(editor.value as? String, initial)
        app.buttons["focus-append"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        var driverSamples: [[String: Any]] = []
        var prefix = initial
        for letter in "abcdefghijkl" {
            let before = ProcessInfo.processInfo.systemUptime
            editor.typeText(String(letter)); prefix += String(letter)
            let observed = editor.value as? String ?? ""
            XCTAssertEqual(observed, prefix)
            driverSamples.append(["before": before, "after": ProcessInfo.processInfo.systemUptime, "value": observed])
        }
        XCTAssertEqual(editor.value as? String, initial + "abcdefghijkl")
        XCTAssertTrue(editor.frame.width > 0 && editor.frame.height > 0)
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "OS keyboard and accessibility value"; before.lifetime = .keepAlways; add(before)
        app.buttons["verify-source"].tap()
        let status = app.staticTexts["scenario-status"]
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
}
