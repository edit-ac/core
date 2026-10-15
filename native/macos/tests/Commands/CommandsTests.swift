import AppKit
import XCTest
@testable import EditacMacOS

private struct UnexpectedResponse: Error {}

@MainActor
final class CommandsTests: XCTestCase {
    private static var launched = false
    private var fixtureOptions: [ObjectIdentifier: NativeSessionOptions] = [:]
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { continuation in
            do { try view.session.submit(request) { continuation.resume(with: $0.mapError { $0 as Error }) } }
            catch { continuation.resume(throwing: error) }
        }
    }

    private func read(_ view: NativeEditorView) async throws -> NativeSessionRead {
        guard case let .snapshot(value) = try await send(view, .read(now: 0)) else { throw UnexpectedResponse() }
        return value
    }

    private func fixture(_ texts: [String],
                         body: @MainActor (NativeEditorView, NativeSessionRead) async throws -> Void) async throws {
        FileHandle.standardError.write(Data(("COMMAND_CASE " + name + "\n").utf8))
        _ = NSApplication.shared
        if !Self.launched {
            NSApp.setActivationPolicy(.regular)
            NSApp.finishLaunching()
            Self.launched = true
        }
        NSApp.activate(ignoringOtherApps: true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-commands-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        window.makeKeyAndOrderFront(nil)
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: directory) }
        let options = NativeSessionOptions(path: directory.appendingPathComponent("document.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil)
        fixtureOptions[ObjectIdentifier(view)] = options
        defer { fixtureOptions.removeValue(forKey: ObjectIdentifier(view)) }
        do {
            let response: NativeSessionResponse = try await withCheckedThrowingContinuation { continuation in
                do {
                    try view.session.open(options: options,
                        initial: texts.map { NativeSessionSeed(kind: "block", text: $0) }, now: 0) {
                            continuation.resume(with: $0.mapError { $0 as Error })
                        }
                } catch { continuation.resume(throwing: error) }
            }
            guard case let .snapshot(snapshot) = response else { throw UnexpectedResponse() }
            XCTAssertTrue(view.textView.window === window)
            XCTAssertNil(view.projectionFailure)
            view.input.now = { 0 }; view.composition.now = { 0 }; view.commands.now = { 0 }
            // XCTest pumps CFRunLoop, but AppKit does not become an active
            // application until its own event loop has run. A run-loop timer
            // stops this bounded host bootstrap without blocking main-queue jobs.
            Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { _ in
                MainActor.assumeIsolated {
                    window.makeKey()
                    NSApp.stop(nil)
                    let wake = NSEvent.otherEvent(with: .applicationDefined, location: .zero,
                        modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                        subtype: 0, data1: 0, data2: 0)!
                    NSApp.postEvent(wake, atStart: true)
                }
            }
            NSApp.run()
            window.makeKey()
            XCTAssertTrue(window.isKeyWindow)
            XCTAssertTrue(window.makeFirstResponder(view.textView))
            try await body(view, snapshot)
        } catch {
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            throw error
        }
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }

    private func edit(_ v: NativeEditorView, _ text: String) async throws {
        let r = try await read(v)
        _ = try await send(v, .nativeEdit(revision: r.revision!, edits: [NativeSessionEdit(
            node: r.nodes[0].id, fromUtf16: 0, toUtf16: UInt32(r.nodes[0].text.utf16.count), text: text)], now: 0))
    }
    private func command(_ v: NativeEditorView, action: () -> Void) async -> Result<Void, NativeCommandFailure> {
        await withCheckedContinuation { c in
            var completed = false
            v.commands.onResult = { result in
                guard !completed else { return }; completed = true
                v.commands.onResult = nil; c.resume(returning: result)
            }
            action()
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                guard !completed else { return }; completed = true
                v.commands.onResult = nil
                XCTFail("Command action did not deliver a result")
                c.resume(returning: .failure(.disabled(.unavailableSession)))
            }
        }
    }
    private func good(_ result: Result<Void, NativeCommandFailure>, file: StaticString = #filePath, line: UInt = #line) {
        if case let .failure(error) = result { XCTFail("\(error)", file: file, line: line) }
    }
    private func service(_ v: NativeEditorView, action: () -> Void) async -> Result<Void, NativeInputFailure> {
        await withCheckedContinuation { c in
            v.composition.onResult = { result in v.composition.onResult = nil; c.resume(returning: result) }
            action()
        }
    }
    func testMenuUndoRedoUsesSharedProjection() async throws {
        try await fixture(["start"]) { v, _ in
            try await edit(v, "changed")
            good(await command(v) { XCTAssertTrue(NSApp.sendAction(NSSelectorFromString("undo:"), to: nil, from: nil)) })
            XCTAssertEqual(v.textView.string, "start")
            good(await command(v) { XCTAssertTrue(NSApp.sendAction(NSSelectorFromString("redo:"), to: nil, from: nil)) })
            XCTAssertEqual(v.textView.string, "changed")
            XCTAssertFalse(v.textView.allowsUndo)
        }
    }
    func testKeyboardUndoRedoUsesSameHistory() async throws {
        try await fixture(["one"]) { v, _ in
            try await edit(v, "two")
            func key(_ flags: NSEvent.ModifierFlags) -> NSEvent {
                NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                    timestamp: 0, windowNumber: v.window!.windowNumber, context: nil,
                    characters: "z", charactersIgnoringModifiers: "z", isARepeat: false, keyCode: 6)!
            }
            good(await command(v) { XCTAssertTrue(v.textView.performKeyEquivalent(with: key(.command))) })
            XCTAssertEqual(v.textView.string, "one")
            good(await command(v) { XCTAssertTrue(v.textView.performKeyEquivalent(with: key([.command, .shift]))) })
            XCTAssertEqual(v.textView.string, "two")
        }
    }
    func testToolbarAndTouchEntryShareHistory() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            good(await command(v) { v.commands.perform(.undo) })
            good(await command(v) { v.commands.perform(.redo) })
            XCTAssertEqual(v.textView.string, "b")
            let committed = try await read(v); XCTAssertTrue(committed.locallyCommitted)
        }
    }
    func testHostFieldOwnsResponder() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            let field = NSTextView(frame: .zero); field.string = "query"; v.addSubview(field)
            XCTAssertTrue(v.window!.makeFirstResponder(field))
            XCTAssertEqual(v.commands.availability(.undo), .unfocused)
            XCTAssertTrue(NSApp.sendAction(#selector(NSTextView.selectAll(_:)), to: nil, from: nil))
            XCTAssertEqual(field.selectedRange(), NSRange(location: 0, length: 5))
            _ = await command(v) { v.commands.perform(.undo) }
            XCTAssertEqual(v.textView.string, "b")
            let current = try await read(v); XCTAssertEqual(current.nodes[0].text, "b")
        }
    }
    func testOnlyFocusedEditorHandlesMenu() async throws {
        try await fixture(["a"]) { first, _ in
            try await edit(first, "b")
            try await fixture(["other"]) { second, _ in
                try await edit(second, "changed")
                XCTAssertEqual(first.commands.availability(.undo), .unfocused)
                good(await command(second) { XCTAssertTrue(NSApp.sendAction(NSSelectorFromString("undo:"), to: nil, from: nil)) })
                XCTAssertEqual(second.textView.string, "other")
                XCTAssertEqual(first.textView.string, "b")
            }
        }
    }
    func testReadOnlyRetainsSelectionAndCopyEnablement() async throws {
        try await fixture(["text"]) { v, _ in
            _ = try await send(v, .permission(writable: false, expiresAt: nil)); _ = try await read(v)
            XCTAssertEqual(v.commands.availability(.undo), .readOnly)
            XCTAssertEqual(v.commands.availability(.selectAll), .enabled)
            XCTAssertEqual(v.commands.availability(.copy), .enabled)
            v.commands.perform(.selectAll)
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 0, length: 4))
            let item = NSMenuItem(title: "Undo", action: NSSelectorFromString("undo:"), keyEquivalent: "z")
            XCTAssertFalse(v.textView.validateUserInterfaceItem(item))
            XCTAssertFalse(v.textView.isEditable)
        }
    }
    func testNativeToolbarAndTouchBarButtonsShareMutationGate() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            let toolbar = v.commands.makeButton(.undo, title: "Undo")
            v.addSubview(toolbar)
            let touchItem = NSCustomTouchBarItem(identifier: .init("editac.commands.redo"))
            let touchButton = v.commands.makeButton(.redo, title: "Redo")
            touchItem.view = touchButton
            XCTAssertTrue(toolbar.isEnabled); XCTAssertTrue(touchButton.isEnabled)
            good(await command(v) { toolbar.performClick(nil) })
            XCTAssertEqual(v.textView.string, "a")
            good(await command(v) { (touchItem.view as! NSButton).performClick(nil) })
            XCTAssertEqual(v.textView.string, "b")
            _ = try await send(v, .commandPermission(writable: false, expiresAt: nil, now: 0))
            XCTAssertFalse(toolbar.isEnabled); XCTAssertFalse(touchButton.isEnabled)
            toolbar.performClick(nil); touchButton.performClick(nil)
            let current = try await read(v); XCTAssertEqual(current.nodes[0].text, "b")
            await withCheckedContinuation { c in v.dispose { c.resume() } }
            XCTAssertFalse(toolbar.isEnabled); XCTAssertFalse(touchButton.isEnabled)
        }
    }
    func testNativeButtonEnablementTracksWindowAndResponderFocus() async throws {
        try await fixture(["first"]) { first, _ in
            let button = first.commands.makeButton(.undo, title: "Undo")
            XCTAssertTrue(button.isEnabled)
            try await fixture(["second"]) { _, _ in
                XCTAssertFalse(button.isEnabled)
            }
            first.window!.makeKey()
            let field = NSTextView(frame: .zero); first.addSubview(field)
            XCTAssertTrue(first.window!.makeFirstResponder(field))
            _ = try await read(first)
            XCTAssertFalse(button.isEnabled)
        }
    }
    func testActualMenuUpdateTracksCurrentSharedPermission() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            let menu = NSMenu(title: "Edit")
            let item = NSMenuItem(title: "Undo", action: NSSelectorFromString("undo:"), keyEquivalent: "z")
            menu.addItem(item); menu.update()
            XCTAssertTrue(item.isEnabled)
            _ = try await send(v, .commandPermission(writable: false, expiresAt: nil, now: 0))
            menu.update(); XCTAssertFalse(item.isEnabled)
            XCTAssertFalse(v.textView.validateMenuItem(item))
        }
    }
    func testUnavailableFormattingCannotMutateNativeStorage() async throws {
        try await fixture(["text"]) { v, _ in
            v.textView.setSelectedRange(NSRange(location: 0, length: 4))
            let before = NSAttributedString(attributedString: v.textView.textStorage!)
            v.textView.underline(nil); v.textView.changeFont(nil)
            v.textView.alignCenter(nil); v.textView.changeColor(nil)
            XCTAssertTrue(before.isEqual(to: v.textView.textStorage!))
            let item = NSMenuItem(title: "Underline", action: #selector(NSTextView.underline(_:)), keyEquivalent: "u")
            XCTAssertFalse(v.textView.validateMenuItem(item))
            let current = try await read(v); XCTAssertEqual(current.nodes[0].text, "text")
        }
    }
    func testHostPermissionPublishesEnabledStateAndExpiry() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            v.commands.now = { 20 }
            _ = try await withCheckedThrowingContinuation { (c: CheckedContinuation<NativeSessionResponse, Error>) in
                do { try v.commands.setPermission(writable: true, expiresAt: 10) {
                    c.resume(with: $0.mapError { $0 as Error })
                } } catch { c.resume(throwing: error) }
            }
            XCTAssertEqual(v.commands.availability(.undo), .readOnly)
            XCTAssertFalse(v.textView.isEditable)
            _ = try await send(v, .commandPermission(writable: true, expiresAt: nil, now: 20))
            XCTAssertEqual(v.commands.availability(.undo), .enabled)
            XCTAssertTrue(v.textView.isEditable)
        }
    }
    func testPermissionRevokedAfterMenuValidationRejectsAtSharedGate() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            XCTAssertEqual(v.commands.availability(.undo), .enabled)
            _ = try await send(v, .permission(writable: false, expiresAt: nil))
            let result = await command(v) { v.commands.perform(.undo) }
            if case .success = result { XCTFail("stale permission accepted") }
            XCTAssertEqual(v.textView.string, "b"); XCTAssertFalse(v.textView.isEditable)
        }
    }
    func testRepeatedPendingActionCannotDoubleUndo() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            var rejected = 0
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                v.commands.onResult = { result in
                    if case .failure(.disabled(.busy)) = result { rejected += 1 }
                    else { v.commands.onResult = nil; c.resume() }
                }
                v.commands.perform(.undo); v.commands.perform(.undo)
            }
            XCTAssertEqual(rejected, 1); XCTAssertEqual(v.textView.string, "a")
        }
    }
    func testEmptyRedoDoesNotRepeatEdit() async throws {
        try await fixture(["a"]) { v, _ in
            try await edit(v, "b")
            _ = await command(v) { v.commands.perform(.redo) }
            _ = await command(v) { v.commands.perform(.redo) }
            XCTAssertEqual(v.textView.string, "b")
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "a")
        }
    }
    func testFindPortIsExplicitAndFocusScoped() async throws {
        try await fixture(["a"]) { v, _ in
            XCTAssertEqual(v.commands.availability(.find), .unavailablePort)
            var called = 0; v.commands.find = { called += 1 }
            v.textView.performFindPanelAction(nil)
            XCTAssertEqual(called, 1)
            XCTAssertEqual(v.textView.string, "a")
        }
    }
    func testMissingStructuralAndTransferPortsAreExplicit() async throws {
        try await fixture(["a"]) { v, _ in
            for command in [NativeCommand.structural, .cut, .paste, .pastePlainText] {
                XCTAssertEqual(v.commands.availability(command), .unavailablePort)
                _ = await self.command(v) { v.commands.perform(command) }
            }
            XCTAssertEqual(v.textView.string, "a")
            XCTAssertFalse(v.commands.isPending)
        }
    }
    func testCapturedServiceDoesNotFollowCaret() async throws {
        try await fixture(["one two"]) { v, _ in
            let target = try await v.commands.captureService(range: NSRange(location: 0, length: 3))
            v.textView.setSelectedRange(NSRange(location: 7, length: 0))
            let result = await service(v) { v.commands.completeService(target, text: "ONE") }
            if case let .failure(error) = result { XCTFail("\(error)") }
            XCTAssertEqual(v.textView.string, "ONE two")
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "one two")
        }
    }
    func testOverlappedServiceRejectsWithoutCaretFallback() async throws {
        try await fixture(["one two"]) { v, _ in
            let target = try await v.commands.captureService(range: NSRange(location: 0, length: 3))
            try await edit(v, "changed")
            let result = await service(v) { v.commands.completeService(target, text: "ONE") }
            if case .success = result { XCTFail("stale service accepted") }
            let current = try await read(v); XCTAssertEqual(current.nodes[0].text, "changed")
        }
    }
    func testCancelledServiceAndDisposedActionsCannotMutate() async throws {
        try await fixture(["one"]) { v, _ in
            let target = try await v.commands.captureService(range: NSRange(location: 0, length: 3))
            v.commands.cancelService(target)
            let result = await service(v) { v.commands.completeService(target, text: "bad") }
            if case .success = result { XCTFail("cancelled service accepted") }
            XCTAssertEqual(v.textView.string, "one")
            await withCheckedContinuation { c in v.dispose { c.resume() } }
            XCTAssertEqual(v.commands.availability(.undo), .unavailableSession)
            v.commands.completeService(target, text: "bad")
            XCTAssertEqual(v.textView.string, "one")
        }
    }
}
