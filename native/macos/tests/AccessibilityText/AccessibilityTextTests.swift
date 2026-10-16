import AppKit
import XCTest
@testable import EditacMacOS

private struct Unexpected: Error {}

@MainActor
final class AccessibilityTextTests: XCTestCase {
    private static var launched = false
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { c in
            do { try view.session.submit(request) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }
    private func read(_ view: NativeEditorView) async throws -> NativeSessionRead {
        guard case let .snapshot(snapshot) = try await send(view, .read(now: 0)) else { throw Unexpected() }
        return snapshot
    }
    private func fixture(_ text: String = "A🦀 אבג e\u{301} Z", body: @MainActor (NativeEditorView, NSWindow) async throws -> Void) async throws {
        _ = NSApplication.shared
        if !Self.launched {
            NSApp.setActivationPolicy(.regular); NSApp.finishLaunching(); Self.launched = true
        }
        NSApp.activate(ignoringOtherApps: true)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editac-accessibility-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 520, height: 220))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view; window.makeKeyAndOrderFront(nil)
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: root) }
        let options = NativeSessionOptions(path: root.appendingPathComponent("document.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(), writable: true, permissionExpiresAt: nil)
        let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            do { try view.session.open(options: options, initial: [NativeSessionSeed(kind: "block", text: text)], now: 0) {
                c.resume(with: $0.mapError { $0 as Error })
            } } catch { c.resume(throwing: error) }
        }
        view.input.now = { 0 }; view.commands.now = { 0 }; view.composition.now = { 0 }
        if let helper = ProcessInfo.processInfo.environment["EDITAC_MACOS_ACTIVATION_HELPER"],
           let evidence = ProcessInfo.processInfo.environment["EDITAC_MACOS_ACTIVATION_EVIDENCE"] {
            let directory = URL(fileURLWithPath: evidence)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let receipt = directory.appendingPathComponent(UUID().uuidString + ".json")
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-n", "-W", helper, "--args", "--yield-activation",
                String(ProcessInfo.processInfo.processIdentifier), receipt.path]
            try process.run(); process.waitUntilExit()
            let value = try JSONSerialization.jsonObject(with: Data(contentsOf: receipt)) as! [String: Any]
            XCTAssertEqual(process.terminationStatus, 0)
            XCTAssertEqual(value["activeBeforeYield"] as? Bool, true)
            XCTAssertEqual(value["targetPID"] as? Int32, ProcessInfo.processInfo.processIdentifier)
        }
        // Activation is asynchronous. Pump AppKit until the OS grants this
        // fixture real focus, rather than assuming a fixed delay is sufficient.
        let textView = view.textView
        var attempts = 0
        Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { timer in
            let stop = MainActor.assumeIsolated {
                attempts += 1
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
                window.makeFirstResponder(textView)
                if NSApp.isActive && window.isKeyWindow && window.firstResponder === textView || attempts >= 100 {
                    NSApp.stop(nil)
                    NSApp.postEvent(NSEvent.otherEvent(with: .applicationDefined, location: .zero,
                        modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                        subtype: 0, data1: 0, data2: 0)!, atStart: true)
                    return true
                }
                return false
            }
            if stop { timer.invalidate() }
        }
        NSApp.run()
        XCTAssertTrue(NSApp.isActive)
        XCTAssertTrue(window.isKeyWindow)
        XCTAssertTrue(window.firstResponder === view.textView)
        print("NATIVE_FOCUS active=\(NSApp.isActive) key=\(window.isKeyWindow) responder=\(window.firstResponder === view.textView) attempts=\(attempts)")
        XCTAssertNil(view.projectionFailure)
        do { try await body(view, window) }
        catch { await withCheckedContinuation { c in view.dispose { c.resume() } }; throw error }
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }
    private func input(_ view: NativeEditorView, action: () -> Void) async throws {
        let result: Result<Void, NativeInputFailure> = await withCheckedContinuation { c in
            view.input.onResult = { result in view.input.onResult = nil; c.resume(returning: result) }; action()
        }
        try result.get()
    }
    private func commands(_ view: NativeEditorView, action: () -> Void) async throws {
        let result: Result<Void, NativeCommandFailure> = await withCheckedContinuation { c in
            view.commands.onResult = { result in view.commands.onResult = nil; c.resume(returning: result) }; action()
        }
        try result.get()
    }
    private func trace(_ value: String) { print("NATIVE_AX_TRACE \(name) \(value)") }

    func testCurrentUnicodeTextSelectionAndScalarSafeRanges() async throws {
        try await fixture { view, _ in
            let text = view.textView
            view.accessibility.label = "Article body"
            XCTAssertEqual(text.accessibilityRole(), .textArea)
            XCTAssertEqual(text.accessibilityLabel(), "Article body")
            XCTAssertEqual(text.accessibilityHelp(), "Editable text")
            XCTAssertEqual(text.accessibilityValue() as? String, text.string)
            XCTAssertEqual(text.accessibilityNumberOfCharacters(), (text.string as NSString).length)
            text.setAccessibilitySelectedTextRange(NSRange(location: 1, length: 2))
            XCTAssertEqual(text.accessibilitySelectedText(), "🦀")
            XCTAssertEqual(text.accessibilitySelectedTextRange(), NSRange(location: 1, length: 2))
            XCTAssertEqual(text.accessibilityString(for: NSRange(location: 4, length: 3)), "אבג")
            XCTAssertEqual(text.accessibilityAttributedString(for: NSRange(location: 1, length: 2))?.string, "🦀")
            for invalid in [NSRange(location: 2, length: 0), NSRange(location: NSNotFound, length: 0),
                            NSRange(location: 0, length: Int.max)] {
                text.setAccessibilitySelectedTextRange(invalid)
                XCTAssertEqual(text.selectedRange(), NSRange(location: 1, length: 2))
                XCTAssertNil(text.accessibilityString(for: invalid)); XCTAssertEqual(text.accessibilityFrame(for: invalid), .zero)
            }
            text.setAccessibilitySelectedTextRanges([NSValue(range: NSRange(location: 4, length: 3))])
            XCTAssertEqual(text.accessibilitySelectedText(), "אבג")
            trace("native text/selection/attributed-range current; invalid surrogate/overflow rejected")
        }
    }

    func testAccessibleReplacementUsesOneActualSharedDurableCommit() async throws {
        try await fixture { view, _ in
            let before = try await read(view)
            view.textView.setAccessibilitySelectedTextRange(NSRange(location: 1, length: 2))
            try await input(view) { view.textView.setAccessibilitySelectedText("✓") }
            let after = try await read(view)
            XCTAssertEqual(view.input.acceptedCount, 1); XCTAssertEqual(after.nodes[0].text, "A✓ אבג e\u{301} Z")
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
            XCTAssertEqual(view.storage.status.receipt?.sequence, 1)
            XCTAssertEqual(view.storage.status.receipt?.checksum.count, 32)
            XCTAssertEqual(view.textView.accessibilityValue() as? String, after.nodes[0].text)
            XCTAssertEqual(view.textView.accessibilitySelectedTextRange(), NSRange(location: 2, length: 0))
            trace("AX replacement -> generated Swift -> Session/SQLite receipt; commits=1")
        }
    }

    func testReadOnlyExposesSelectionAndDeniesAllAccessibleMutation() async throws {
        try await fixture { view, _ in
            _ = try await send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            let before = try await read(view)
            XCTAssertFalse(view.textView.isEditable)
            XCTAssertEqual(view.textView.accessibilityHelp(), "Read-only text")
            view.textView.setAccessibilitySelectedTextRange(NSRange(location: 1, length: 2))
            view.textView.setAccessibilitySelectedText("denied"); view.textView.setAccessibilityValue("denied")
            let after = try await read(view)
            XCTAssertEqual(before.revision, after.revision); XCTAssertEqual(before.pendingUpload, after.pendingUpload)
            XCTAssertEqual(view.textView.accessibilitySelectedText(), "🦀")
            let names = view.textView.accessibilityCustomActions()?.map(\.name) ?? []
            XCTAssertTrue(names.contains("Select all")); XCTAssertTrue(names.contains("Copy"))
            XCTAssertFalse(names.contains("Undo")); XCTAssertFalse(names.contains("Bold"))
            trace("read-only selection/copy available; replacement/value/history mutation denied")
        }
    }

    func testAccessibleUndoAndRetainedActionRecheckRevocation() async throws {
        try await fixture { view, _ in
            try await input(view) { view.textView.setAccessibilityValue("replacement") }
            let undo = try XCTUnwrap(view.textView.accessibilityCustomActions()?.first { $0.name == "Undo" })
            try await commands(view) { XCTAssertTrue(undo.handler?() == true) }
            XCTAssertEqual(view.textView.string, "A🦀 אבג e\u{301} Z")
            let redo = try XCTUnwrap(view.textView.accessibilityCustomActions()?.first { $0.name == "Redo" })
            _ = try await send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            XCTAssertFalse(redo.handler?() ?? true)
            let button = view.commands.makeButton(.redo, title: "Redo edit")
            XCTAssertEqual(button.accessibilityTitle(), "Redo edit"); XCTAssertFalse(button.isEnabled)
            trace("AX Undo invokes shared history; retained Redo rejects revoked permission")
        }
    }

    func testCurrentScreenGeometryAcrossBidiScrollAndDeclaredMagnification() async throws {
        try await fixture((0..<50).map { "Line \($0) אבג 🦀" }.joined(separator: "\n")) { view, _ in
            let text = view.textView
            view.scrollView.allowsMagnification = true
            let range = NSRange(location: 0, length: 4)
            var heights: [CGFloat] = []
            for scale in [1.0, 1.5, 2.0] {
                view.scrollView.magnification = scale
                text.layoutManager?.ensureLayout(for: text.textContainer!)
                let frame = text.accessibilityFrame(for: range)
                XCTAssertGreaterThan(frame.width, 0); XCTAssertGreaterThan(frame.height, 0)
                let index = text.accessibilityRange(for: NSPoint(x: frame.midX, y: frame.midY))
                XCTAssertNotEqual(index.location, NSNotFound)
                XCTAssertLessThan(index.location, 5)
                heights.append(frame.height)
                trace("NAT-13 magnification=\(scale) screenFrame=\(frame) hit=\(index)")
            }
            XCTAssertGreaterThan(heights[2], heights[0])
            let last = NSRange(location: (text.string as NSString).length - 2, length: 2)
            text.scrollRangeToVisible(last)
            let visible = text.accessibilityVisibleCharacterRange()
            XCTAssertGreaterThan(visible.location + visible.length, last.location)
            XCTAssertGreaterThan(text.accessibilityFrame(for: last).height, 0)
            let before = text.accessibilityFrame(for: NSRange(location: 0, length: 1))
            try await input(view) { text.setAccessibilityValue("new\nאבג 🦀") }
            text.layoutManager?.ensureLayout(for: text.textContainer!)
            XCTAssertEqual(text.accessibilityString(for: NSRange(location: 4, length: 3)), "אבג")
            XCTAssertGreaterThan(text.accessibilityFrame(for: NSRange(location: 4, length: 3)).width, 0)
            text.setAccessibilitySelectedTextRange(NSRange(location: 5, length: 0))
            text.moveLeft(nil)
            XCTAssertEqual(text.accessibilitySelectedTextRange(), text.selectedRange())
            XCTAssertNotEqual(text.selectedRange().location, 5)
            XCTAssertGreaterThan(text.accessibilityFrame(for: text.selectedRange()).height, 0)
            trace("NAT-13 after-edit current geometry; previous=\(before)")
        }
    }

    func testKeyboardFocusAndAccessibleSelectAllUseActualResponder() async throws {
        try await fixture { view, window in
            XCTAssertTrue(view.textView.isAccessibilityFocused())
            let other = NSTextField(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
            view.addSubview(other); XCTAssertTrue(window.makeFirstResponder(other))
            XCTAssertFalse(view.textView.isAccessibilityFocused())
            XCTAssertEqual(view.textView.accessibilityCustomActions()?.count, 0)
            view.textView.setAccessibilityFocused(true)
            XCTAssertTrue(window.firstResponder === view.textView)
            let all = try XCTUnwrap(view.textView.accessibilityCustomActions()?.first { $0.name == "Select all" })
            XCTAssertTrue(all.handler?() == true)
            XCTAssertEqual(view.textView.accessibilitySelectedText(), view.textView.string)
            XCTAssertTrue(NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil))
            XCTAssertTrue(view.textView.acceptsFirstResponder)
            trace("native AX focus -> first responder -> action/keyboard select-all")
        }
    }

    func testNativeTextQueriesDoNotWaitForBlockedSessionWorker() async throws {
        try await fixture { view, _ in
            let gate = DispatchSemaphore(value: 0)
            view.session.enqueueBarrier { gate.wait() }
            defer { gate.signal() }
            let before = view.textView.string
            for _ in 0..<100 {
                XCTAssertEqual(view.textView.accessibilityString(for: NSRange(location: 1, length: 2)), "🦀")
                XCTAssertEqual(view.textView.accessibilityValue() as? String, before)
                XCTAssertGreaterThan(view.textView.accessibilityFrame(for: NSRange(location: 4, length: 3)).width, 0)
            }
            trace("NAT-14 300 synchronous native queries completed while Session worker blocked; no worker reads")
        }
    }

    func testReentrantNativeTextStorageTransactionDuringAsyncCommit() async throws {
        try await fixture { view, _ in
            let original = view.session.onProjection
            var traces = 0
            view.session.onProjection = { update in
                view.textView.textStorage?.beginEditing()
                XCTAssertNotNil(view.textView.accessibilityString(for: NSRange(location: 0, length: 1)))
                original?(update)
                XCTAssertEqual(view.textView.accessibilityValue() as? String, view.textView.string)
                view.textView.setAccessibilityValue("recursive overwrite")
                XCTAssertTrue(view.input.isPending, "accepted edit stays pending through projection callback")
                XCTAssertNotEqual(view.textView.string, "recursive overwrite")
                view.textView.textStorage?.endEditing()
                XCTAssertGreaterThan(view.textView.accessibilityFrame(for: NSRange(location: 0, length: 1)).height, 0)
                traces += 1
            }
            try await input(view) { view.textView.setAccessibilityValue("committed אבג") }
            view.session.onProjection = original
            XCTAssertEqual(traces, 1); XCTAssertEqual(view.input.acceptedCount, 1)
            XCTAssertEqual(view.textView.accessibilityString(for: NSRange(location: 10, length: 3)), "אבג")
            trace("NAT-14 main-actor native beginEditing/query/projection/query/endEditing/geometry; commits=1 callbacks=1")
        }
    }

    func testCompositionSurroundingTextAndAccessibilityQueryPreserveInput() async throws {
        try await fixture { view, _ in
            view.textView.setMarkedText("かな", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: 1, length: 2))
            XCTAssertTrue(view.textView.hasMarkedText())
            XCTAssertEqual(view.textView.accessibilityHelp(), "Composing text")
            XCTAssertTrue((view.textView.accessibilityValue() as? String)?.contains("かな") == true)
            let before = try await read(view)
            view.textView.setAccessibilityValue("must not overwrite composition")
            XCTAssertTrue(view.textView.hasMarkedText()); XCTAssertEqual(view.input.acceptedCount, 0)
            let cancelled: Result<Void, NativeInputFailure> = await withCheckedContinuation { c in
                view.composition.onResult = { result in view.composition.onResult = nil; c.resume(returning: result) }
                view.composition.cancel()
            }
            try cancelled.get()
            let after = try await read(view)
            XCTAssertEqual(before.revision, after.revision)
            XCTAssertEqual(view.textView.accessibilityValue() as? String, after.nodes[0].text)
            trace("marked native text visible; AX overwrite rejected; cancel restores committed projection")
        }
    }

    func testDisposedViewSuppressesRetainedActionsAndAccessibleSetters() async throws {
        try await fixture { view, _ in
            let action = try XCTUnwrap(view.textView.accessibilityCustomActions()?.first { $0.name == "Select all" })
            let before = view.textView.string
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            let count = view.sessionDeliveryCount
            XCTAssertFalse(action.handler?() ?? true)
            view.textView.setAccessibilitySelectedText("denied"); view.textView.setAccessibilityValue("denied")
            view.textView.setAccessibilitySelectedTextRange(NSRange(location: 0, length: 1))
            XCTAssertEqual(view.textView.string, before); XCTAssertEqual(view.sessionDeliveryCount, count)
            XCTAssertEqual(view.textView.accessibilityHelp(), "Editor unavailable")
            XCTAssertTrue(view.textView.accessibilityCustomActions()?.isEmpty == true)
            trace("disposed view actions/setters fail closed; callbacks unchanged")
        }
    }
}
