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
    func testNativeUndoManagerForwardsSharedHistoryWithoutRegisteringProjection() async throws {
        try await fixture(["start"]) { v, _ in
            let manager = try XCTUnwrap(v.textView.undoManager)
            XCTAssertTrue(manager === v.commandUndoManager)
            XCTAssertFalse(manager.isUndoRegistrationEnabled)
            XCTAssertFalse(manager.canUndo); XCTAssertFalse(manager.canRedo)
            try await edit(v, "changed")
            XCTAssertTrue(manager.canUndo); XCTAssertFalse(manager.canRedo)
            good(await command(v) { manager.undo() })
            XCTAssertEqual(v.textView.string, "start")
            XCTAssertFalse(manager.canUndo); XCTAssertTrue(manager.canRedo)
            good(await command(v) { manager.redo() })
            XCTAssertEqual(v.textView.string, "changed")
            XCTAssertTrue(manager.canUndo); XCTAssertFalse(manager.canRedo)
            XCTAssertEqual(manager.groupingLevel, 0)
            XCTAssertFalse(v.textView.allowsUndo)
            v.window?.makeFirstResponder(nil)
            XCTAssertFalse(manager.canUndo); XCTAssertFalse(manager.canRedo)
            v.window?.makeFirstResponder(v.textView)
            XCTAssertTrue(manager.canUndo)
            let host = NSTextView(frame: NSRect(x: 0, y: 0, width: 100, height: 40))
            host.allowsUndo = true; v.addSubview(host)
            v.window?.makeFirstResponder(host)
            host.insertText("host edit", replacementRange: NSRange(location: 0, length: 0))
            XCTAssertFalse(manager.canUndo)
            XCTAssertFalse(host.undoManager === manager)
            XCTAssertTrue(host.undoManager?.canUndo == true)
            host.undoManager?.undo()
            XCTAssertEqual(host.string, "")
            XCTAssertEqual(v.textView.string, "changed")
            host.removeFromSuperview()
            v.window?.makeFirstResponder(v.textView)
            XCTAssertTrue(manager.canUndo)
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
            XCTAssertTrue(toolbar.isEnabled); XCTAssertFalse(touchButton.isEnabled)
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
            try await edit(first, "changed")
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
            v.textView.changeFont(nil)
            v.textView.alignCenter(nil); v.textView.changeColor(nil)
            XCTAssertTrue(before.isEqual(to: v.textView.textStorage!))
            let item = NSMenuItem(title: "Font", action: #selector(NSTextView.changeFont(_:)), keyEquivalent: "")
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
    private func json(_ values: [[String: Any]]) throws -> String {
        String(data: try JSONSerialization.data(withJSONObject: values), encoding: .utf8)!
    }
    func testCatalogAndProfilesComeFromActualSession() async throws {
        try await fixture(["text"]) { v, r in
            let catalog = try XCTUnwrap(v.commands.catalog)
            XCTAssertEqual(catalog.revision, r.revision)
            XCTAssertEqual(v.commands.profileAvailability("editac.core")?.available, true)
            for id in ["editac.document-tools", "editac.code-tools", "editac.references", "editac.images"] {
                let profile = try XCTUnwrap(v.commands.profileAvailability(id))
                XCTAssertFalse(profile.available); XCTAssertFalse(profile.reason.isEmpty)
            }
            for id in ["markAt", "split", "wrap", "indent", "outdent", "setChecked", "move", "setParagraph", "setCode"] {
                let route = try XCTUnwrap(catalog.routes.first { $0.id == id })
                XCTAssertTrue(route.available); XCTAssertTrue(route.canPrepare)
            }
            XCTAssertEqual(catalog.routes.first { $0.id == "tableCell" }?.available, false)
        }
    }
    func testExactSharedHistoryEnablesOnlyNonemptyStack() async throws {
        try await fixture(["a"]) { v, _ in
            XCTAssertEqual(v.commands.availability(.undo), .emptyHistory)
            XCTAssertEqual(v.commands.availability(.redo), .emptyHistory)
            XCTAssertEqual(v.commands.history?.undoGroups, 0)
            try await edit(v, "b")
            XCTAssertEqual(v.commands.availability(.undo), .enabled)
            XCTAssertEqual(v.commands.availability(.redo), .emptyHistory)
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.commands.availability(.undo), .emptyHistory)
            XCTAssertEqual(v.commands.availability(.redo), .enabled)
            good(await command(v) { v.commands.perform(.redo) })
            XCTAssertEqual(v.commands.availability(.redo), .emptyHistory)
        }
    }
    func testNativeMarkMenuKeyboardAndTouchUseOneSharedHistory() async throws {
        try await fixture(["text"]) { v, _ in
            v.textView.setSelectedRange(NSRange(location: 0, length: 4))
            let underlineState = await v.commands.validate(.underline)
            XCTAssertEqual(underlineState, .enabled)
            let item = NSMenuItem(title: "Underline", action: #selector(NSTextView.underline(_:)), keyEquivalent: "u")
            XCTAssertTrue(v.textView.validateMenuItem(item))
            good(await command(v) { XCTAssertTrue(NSApp.sendAction(item.action!, to: nil, from: item)) })
            let attributes = try XCTUnwrap(v.textView.textStorage?.attribute(
                NativeTextProjection.sharedRunAttributes, at: 0, effectiveRange: nil) as? NSDictionary)
            XCTAssertNotNil(attributes["underline"])
            XCTAssertEqual(v.commands.history?.undoGroups, 1)
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.commands.history?.undoGroups, 0)
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
                timestamp: 0, windowNumber: v.window!.windowNumber, context: nil,
                characters: "b", charactersIgnoringModifiers: "b", isARepeat: false, keyCode: 11)!
            good(await command(v) { XCTAssertTrue(v.textView.performKeyEquivalent(with: event)) })
            XCTAssertEqual(v.commands.history?.undoGroups, 1)
            good(await command(v) { v.commands.perform(.undo) })
            let italicState = await v.commands.validate(.italic)
            XCTAssertEqual(italicState, .enabled)
            let touch = NSCustomTouchBarItem(identifier: .init("editac.italic"))
            touch.view = v.commands.makeButton(.italic, title: "Italic")
            good(await command(v) { (touch.view as! NSButton).performClick(nil) })
            XCTAssertEqual(v.commands.history?.undoGroups, 1)
            XCTAssertEqual(v.textView.string, "text"); XCTAssertFalse(v.textView.allowsUndo)
        }
    }
    func testNativeSplitUsesSharedAnchorsAndPlacesCaretInNewBlock() async throws {
        try await fixture(["ab"]) { v, _ in
            v.textView.setSelectedRange(NSRange(location: 1, length: 0))
            good(await command(v) { v.textView.doCommand(by: #selector(NSResponder.insertNewline(_:))) })
            let r = try await read(v)
            XCTAssertEqual(r.nodes.map(\.text), ["a", "b"])
            XCTAssertEqual(v.textView.string, "a\nb")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 2, length: 0))
            XCTAssertEqual(v.commands.history?.undoGroups, 1)
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "ab")
        }
    }
    func testStructuralBatchUsesPlannerAndOneUndoGroup() async throws {
        try await fixture(["first", "second"]) { v, r in
            let project = v.session.onProjection
            v.session.onProjection = { update in
                project?(update)
                if v.projectionFailure != nil, case let .success(value) = update {
                    FileHandle.standardError.write(Data(("COMMAND_PROJECTION_DIAGNOSTIC "
                        + (value.patches?.patchesJson.joined(separator: "\n") ?? value.snapshot?.snapshotJson ?? "none") + "\n").utf8))
                }
            }
            let payload = try json([["type": "wrap", "targets": r.nodes.map(\.id),
                                     "style": ["type": "checklist"]]])
            try await v.commands.check(commandsJSON: payload)
            XCTAssertEqual(v.commands.history?.undoGroups, 0)
            good(await command(v) { v.commands.perform(commandsJSON: payload) })
            XCTAssertEqual(v.commands.history?.undoGroups, 1)
            XCTAssertEqual(v.textView.string, "first\nsecond")
            XCTAssertEqual(v.projection.richNodes.values.filter { $0.kind == "list" }.count, 1)
            XCTAssertEqual(v.projection.nodes.map(\.id), r.nodes.map(\.id))
            let checked = try json([["type": "setChecked", "owner": r.nodes[0].id, "checked": true]])
            try await v.commands.check(commandsJSON: checked)
            good(await command(v) { v.commands.perform(commandsJSON: checked) })
            XCTAssertEqual((v.projection.richNodes[r.nodes[0].id]?.wire["editor"] as? [String: Any])?["checked"] as? Bool, true)
            XCTAssertNil(v.projectionFailure)
            good(await command(v) { v.commands.perform(.undo) })
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "first\nsecond")
        }
    }
    func testTargetPlannerRejectsCatalogAvailableButInvalidCommand() async throws {
        try await fixture(["text"]) { v, r in
            XCTAssertEqual(v.commands.catalog?.routes.first { $0.id == "setChecked" }?.canPrepare, true)
            let payload = try json([["type": "setChecked", "owner": r.nodes[0].id, "checked": true]])
            do { try await v.commands.check(commandsJSON: payload); XCTFail("Non-checklist target admitted") }
            catch { }
            let result = await command(v) { v.commands.perform(commandsJSON: payload) }
            if case .success = result { XCTFail("Invalid target committed") }
            XCTAssertEqual(v.textView.string, "text"); XCTAssertEqual(v.commands.history?.undoGroups, 0)
            XCTAssertNil(v.projectionFailure)
        }
    }
    func testStalePortablePayloadCannotFollowLatestCaret() async throws {
        try await fixture(["one two"]) { v, r in
            let payload = try json([["type": "replaceAt", "owner": r.nodes[0].id, "from": 0, "to": 3, "text": "ONE"]])
            try await edit(v, "changed")
            v.textView.setSelectedRange(NSRange(location: 7, length: 0))
            let result = await command(v) { v.commands.perform(commandsJSON: payload, revision: r.revision) }
            if case .success = result { XCTFail("Stale revision committed") }
            XCTAssertEqual(v.textView.string, "changed"); XCTAssertNil(v.projectionFailure)
        }
    }
    func testUnavailableProfilesAndRoutesCannotDispatch() async throws {
        try await fixture(["text"]) { v, r in
            let payload = try json([["type": "setParagraph", "owner": r.nodes[0].id]])
            let result = await command(v) { v.commands.perform(commandsJSON: payload, profile: "editac.document-tools") }
            if case .success = result { XCTFail("Unavailable profile dispatched") }
            for payload in ["[]", "[{\"type\":\"unknown\"}]", "[{\"type\":\"tableCell\"}]"] {
                let result = await command(v) { v.commands.perform(commandsJSON: payload) }
                if case .success = result { XCTFail("Unavailable route dispatched") }
            }
            XCTAssertEqual(v.textView.string, "text"); XCTAssertEqual(v.commands.history?.undoGroups, 0)
        }
    }
    func testInjectedTransferRoutesMenuAndPlainPasteThroughSharedGate() async throws {
        try await fixture(["one two"]) { v, _ in
            var calls: [NativeCommand] = []
            v.commands.transfer = { command, target in
                calls.append(command)
                return try self.json([["type": "replaceAt", "owner": target.anchor.node,
                    "from": target.anchor.offsetUTF16, "to": target.focus.offsetUTF16,
                    "text": command == .cut ? "" : "PASTE"]])
            }
            v.textView.setSelectedRange(NSRange(location: 0, length: 3))
            good(await command(v) { XCTAssertTrue(NSApp.sendAction(#selector(NSTextView.cut(_:)), to: nil, from: nil)) })
            XCTAssertEqual(v.textView.string, " two")
            good(await command(v) { v.commands.perform(.undo) })
            v.textView.setSelectedRange(NSRange(location: 0, length: 3))
            good(await command(v) { v.textView.pasteAsPlainText(nil) })
            XCTAssertEqual(v.textView.string, "PASTE two")
            XCTAssertEqual(calls, [.cut, .pastePlainText])
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "one two")
        }
    }
    func testTransferRevalidatesPermissionAfterInjectedDispatch() async throws {
        try await fixture(["one"]) { v, _ in
            v.commands.transfer = { _, target in
                try v.session.submit(.permission(writable: false, expiresAt: nil))
                return try self.json([["type": "replaceAt", "owner": target.anchor.node,
                                      "from": 0, "to": 3, "text": "bad"]])
            }
            let result = await command(v) { v.commands.perform(.paste) }
            if case .success = result { XCTFail("Revoked transfer committed") }
            XCTAssertEqual(v.textView.string, "one"); XCTAssertFalse(v.textView.isEditable)
        }
    }
    func testHostQueryOwnsFormattingAndInjectedTransfer() async throws {
        try await fixture(["text"]) { v, _ in
            var calls = 0; v.commands.transfer = { _, _ in calls += 1; return "[]" }
            let field = NSTextView(frame: .zero); field.string = "query"; v.addSubview(field)
            XCTAssertTrue(v.window!.makeFirstResponder(field))
            for action in [NativeCommand.bold, .split, .paste, .cut] {
                XCTAssertEqual(v.commands.availability(action), .unfocused)
                _ = await command(v) { v.commands.perform(action) }
            }
            XCTAssertEqual(calls, 0); XCTAssertEqual(v.textView.string, "text")
        }
    }
    func testDisposalCompletesPendingPlannerCheckWithoutViewCallback() async throws {
        try await fixture(["text"]) { v, r in
            let payload = try json([["type": "setParagraph", "owner": r.nodes[0].id]])
            let task = Task { @MainActor in try await v.commands.check(commandsJSON: payload) }
            // Queue the check on the actor before disposal; disposal must release
            // its continuation even when executor delivery is suppressed.
            await Task.yield()
            await withCheckedContinuation { c in v.dispose { c.resume() } }
            do { try await task.value } catch { }
            XCTAssertEqual(v.commands.availability(.paragraph), .unavailableSession)
            XCTAssertFalse(v.commands.isPending)
        }
    }
    func testNativeEnterReplacesSelectionInOneSharedIntent() async throws {
        try await fixture(["abcd"]) { v, _ in
            v.textView.setSelectedRange(NSRange(location: 1, length: 2))
            good(await command(v) { v.textView.doCommand(by: #selector(NSResponder.insertNewline(_:))) })
            XCTAssertEqual(v.textView.string, "a\nd")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 2, length: 0))
            XCTAssertEqual(v.commands.history?.undoGroups, 1)
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                v.input.onResult = { result in
                    if case let .failure(error) = result { XCTFail("\(error)") }
                    v.input.onResult = nil; c.resume()
                }
                v.textView.insertText("X", replacementRange: NSRange(location: NSNotFound, length: 0))
            }
            XCTAssertEqual(v.textView.string, "a\nXd")
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "a\nd")
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "abcd")
        }
    }
    func testNativeEnterUsesSharedEmptyChecklistExitPolicy() async throws {
        try await fixture([""]) { v, r in
            let payload = try json([["type": "wrap", "targets": [r.nodes[0].id], "style": ["type": "checklist"]]])
            good(await command(v) { v.commands.perform(commandsJSON: payload) })
            XCTAssertEqual((v.projection.richNodes[r.nodes[0].id]?.wire["editor"] as? [String: Any])?["checked"] as? Bool, false)
            good(await command(v) { v.textView.doCommand(by: #selector(NSResponder.insertNewline(_:))) })
            XCTAssertEqual(v.projection.nodes.count, 1)
            XCTAssertEqual(v.projection.nodes[0].id, r.nodes[0].id)
            XCTAssertEqual(v.projection.richNodes[r.nodes[0].id]?.wire["parent"] as? String, "@root")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 0, length: 0))
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertNotEqual(v.projection.richNodes[r.nodes[0].id]?.wire["parent"] as? String, "@root")
        }
    }
    func testFormattingButtonTracksCurrentSelectionApplicability() async throws {
        try await fixture(["text"]) { v, _ in
            v.textView.setSelectedRange(NSRange(location: 0, length: 4))
            let button = v.commands.makeButton(.bold, title: "Bold")
            let valid = await v.commands.validate(.bold)
            XCTAssertEqual(valid, .enabled); XCTAssertTrue(button.isEnabled)
            v.textView.setSelectedRange(NSRange(location: 4, length: 0))
            XCTAssertEqual(v.commands.availability(.bold), .inapplicable)
            XCTAssertFalse(button.isEnabled)
            v.textView.setSelectedRange(NSRange(location: 0, length: 4))
            let restored = await v.commands.validate(.bold)
            XCTAssertEqual(restored, .enabled); XCTAssertTrue(button.isEnabled)
        }
    }
    func testNativeCodeReturnUsesSharedHardBreakWithoutSplittingBlock() async throws {
        try await fixture(["code"]) { v, r in
            let payload = try json([["type": "setCode", "owner": r.nodes[0].id, "language": "swift"]])
            good(await command(v) { v.commands.perform(commandsJSON: payload) })
            v.textView.setSelectedRange(NSRange(location: 2, length: 0))
            good(await command(v) { v.textView.doCommand(by: #selector(NSResponder.insertNewline(_:))) })
            XCTAssertEqual(v.projection.nodes.count, 1)
            XCTAssertEqual(v.textView.string, "co\nde")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 3, length: 0))
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "code")
        }
    }
    func testNativeBatchRetainsSequentialUtf16Coordinates() async throws {
        try await fixture(["ab"]) { v, r in
            _ = try await send(v, .nativeEdit(revision: r.revision!, edits: [
                NativeSessionEdit(node: r.nodes[0].id, fromUtf16: 0, toUtf16: 0, text: "X"),
                NativeSessionEdit(node: r.nodes[0].id, fromUtf16: 3, toUtf16: 3, text: "Y")], now: 0))
            XCTAssertEqual(v.textView.string, "XabY")
            XCTAssertEqual(v.commands.history?.undoGroups, 1)
            good(await command(v) { v.commands.perform(.undo) })
            XCTAssertEqual(v.textView.string, "ab")
        }
    }
}
