import AppKit
import XCTest
@testable import EditacMacOS

private struct Unexpected: Error {}
@MainActor private final class StructureRenderer: NativeAtomRenderer {
    let view: NSView = NSTextField(labelWithString: "")
    func update(_ descriptor: NativeExtensionDescriptor) throws {
        (view as! NSTextField).stringValue = "Badge: " + descriptor.source
        view.setAccessibilityLabel(descriptor.source)
    }
    func dispose() { view.removeFromSuperview() }
}

@MainActor
final class AccessibilityStructureTests: XCTestCase {
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
    private func fixture(body: @MainActor (NativeEditorView, NSWindow) async throws -> Void) async throws {
        _ = NSApplication.shared
        if !Self.launched {
            NSApp.setActivationPolicy(.regular); NSApp.finishLaunching(); Self.launched = true
        }
        NSApp.activate(ignoringOtherApps: true)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editac-accessibility-structure-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 520, height: 220))
        try view.extensions.registerAtom(type: "example.badge", version: 1) { _ in StructureRenderer() }
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view; window.makeKeyAndOrderFront(nil)
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: root) }
        let manifestPath = try XCTUnwrap(ProcessInfo.processInfo.environment["EDITAC_MACOS_STRUCTURE_FIXTURE"])
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: manifestPath))) as! [String: Any]
        let store = root.appendingPathComponent("document.sqlite")
        try FileManager.default.copyItem(atPath: manifest["path"] as! String, toPath: store.path)
        let options = NativeSessionOptions(path: store.path,
            documentId: manifest["documentId"] as! String, epoch: manifest["epoch"] as! String,
            writable: true, permissionExpiresAt: nil)
        let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            do { try view.session.open(options: options, now: 0) {
                c.resume(with: $0.mapError { $0 as Error })
            } } catch { c.resume(throwing: error) }
        }
        _ = try await send(view, .tablePolicy(enabled: true))
        _ = try await send(view, .atomicContentPolicy(images: true, references: true))
        _ = try await send(view, .extensionPolicy(enabled: true))
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
    private func table(_ view: NativeEditorView, spans: Bool = false) throws -> NativeTableView {
        try XCTUnwrap(view.projection.tableViews.values.first { table in
            table.cells.values.contains { $0.rowSpan > 1 || $0.columnSpan > 1 } == spans
        })
    }
    private func image(_ view: NativeEditorView) throws -> NativeAttachmentView {
        try XCTUnwrap(view.attachments.views.values.first { $0.descriptor.kind == .image })
    }
    private func atom(_ view: NativeEditorView) throws -> NativeExtensionView {
        try XCTUnwrap(view.extensions.views.values.first { $0.descriptor.type == "example.badge" })
    }
    private func action(_ name: String, _ actions: [NSAccessibilityCustomAction]?) throws -> NSAccessibilityCustomAction {
        try XCTUnwrap(actions?.first { $0.name == name })
    }
    private func turn() async {
        await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
    }
    func testTableRowsColumnsAndReciprocalCellParents() async throws {
        try await fixture { view, _ in
            let table = try self.table(view)
            XCTAssertEqual(table.accessibilityRole(), .table)
            let rows = try XCTUnwrap(table.accessibilityRows() as? [NSAccessibilityElement])
            let columns = try XCTUnwrap(table.accessibilityColumns() as? [NSAccessibilityElement])
            XCTAssertEqual(rows.count, table.rowCount); XCTAssertEqual(columns.count, table.columnCount)
            for (index, row) in rows.enumerated() {
                XCTAssertEqual(row.accessibilityRole(), .row)
                XCTAssertTrue(row.accessibilityParent() as? NativeTableView === table)
                for element in row.accessibilityChildren() as! [NativeAccessibleCell] {
                    XCTAssertEqual(element.accessibilityRowIndexRange().location, index)
                    XCTAssertTrue(element.accessibilityParent() as? NSAccessibilityElement === row)
                    XCTAssertTrue(element.control?.accessibilityParent() as? NativeAccessibleCell === element)
                    XCTAssertEqual(element.control?.accessibilityRole(), .textArea)
                }
            }
            XCTAssertTrue(columns.allSatisfy { $0.accessibilityRole() == .column })
        }
    }
    func testSpannedCellsResolveCoveredCoordinatesAndRanges() async throws {
        try await fixture { view, _ in
            let table = try self.table(view, spans: true)
            for control in table.cells.values {
                let element = try XCTUnwrap(table.accessibilityCell(forColumn: control.coordinate.column, row: control.coordinate.row) as? NativeAccessibleCell)
                XCTAssertEqual(element.accessibilityRowIndexRange(), NSRange(location: control.coordinate.row, length: control.rowSpan))
                XCTAssertEqual(element.accessibilityColumnIndexRange(), NSRange(location: control.coordinate.column, length: control.columnSpan))
                for row in control.coordinate.row..<(control.coordinate.row + control.rowSpan) {
                    for column in control.coordinate.column..<(control.coordinate.column + control.columnSpan) {
                        XCTAssertTrue(table.accessibilityCell(forColumn: column, row: row) as? NativeAccessibleCell === element)
                    }
                }
            }
            XCTAssertNil(table.accessibilityCell(forColumn: -1, row: 0))
            XCTAssertNil(table.accessibilityCell(forColumn: Int.max, row: Int.max))
        }
    }
    func testHeaderRelationshipsUseSharedHeaderFlags() async throws {
        try await fixture { view, _ in
            for table in view.projection.tableViews.values {
                let headers = try XCTUnwrap(table.accessibilityColumnHeaderUIElements() as? [NativeAccessibleCell])
                XCTAssertEqual(headers.count, table.cells.values.filter(\.isHeaderCell).count)
                XCTAssertTrue(headers.allSatisfy { $0.control?.isHeaderCell == true })
            }
        }
    }
    func testActualSessionResyncPreservesAccessibilityIdentity() async throws {
        try await fixture { view, _ in
            let table = try self.table(view)
            let old = try XCTUnwrap(table.accessibilityCell(forColumn: 0, row: 0) as? NativeAccessibleCell)
            let row = table.accessibilityRows()?.first as? NSAccessibilityElement
            _ = try await self.send(view, .resyncProjection)
            XCTAssertTrue(table.accessibilityCell(forColumn: 0, row: 0) as? NativeAccessibleCell === old)
            XCTAssertTrue(table.accessibilityRows()?.first as? NSAccessibilityElement === row)
            XCTAssertTrue(old.control === table.cells[.init(row: 0, column: 0)])
        }
    }
    func testCellAccessibilityPressFocusesActualNativeTextControl() async throws {
        try await fixture { view, window in
            let element = try XCTUnwrap(self.table(view).accessibilityCell(forColumn: 0, row: 0) as? NativeAccessibleCell)
            XCTAssertTrue(element.accessibilityPerformPress())
            XCTAssertTrue(window.firstResponder === element.control)
            XCTAssertTrue(element.control?.isAccessibilityFocused() == true)
            XCTAssertGreaterThan(element.accessibilityFrame().width, 0)
        }
    }
    func testImageAltTextAndHostFailureAreAccessibleWithoutMutation() async throws {
        try await fixture { view, window in
            let image = try self.image(view), revision = view.projection.revision
            XCTAssertEqual(image.accessibilityRole(), .group)
            XCTAssertEqual(image.imageView.accessibilityLabel(), image.descriptor.label)
            XCTAssertEqual(image.accessibilityLabel(), "Image: " + image.descriptor.label)
            XCTAssertTrue(image.accessibilityPerformPress()); XCTAssertTrue(window.firstResponder === image.selectButton)
            view.attachments.resolve(image.nodeID)
            XCTAssertTrue(image.status.accessibilityLabel()?.contains("unavailable") == true)
            XCTAssertEqual(view.projection.revision, revision)
        }
    }
    func testReferenceLabelTargetAndReachableActivation() async throws {
        try await fixture { view, window in
            let reference = try XCTUnwrap(view.attachments.views.values.first { $0.descriptor.kind == .reference })
            XCTAssertEqual(reference.accessibilityLabel(), "Reference: " + reference.descriptor.label)
            XCTAssertFalse(reference.descriptor.target.isEmpty)
            XCTAssertTrue(reference.accessibilityPerformPress()); XCTAssertTrue(window.firstResponder === reference.selectButton)
            let open = try self.action("Open reference", reference.accessibilityCustomActions())
            XCTAssertTrue(open.handler?() == true)
            XCTAssertTrue(reference.status.stringValue.contains("unavailable"))
        }
    }
    func testReadOnlyRemovesMutatingAtomActionsAndRetainedActionsFailClosed() async throws {
        try await fixture { view, _ in
            let image = try self.image(view)
            let remove = try self.action("Remove", image.accessibilityCustomActions())
            _ = try await self.send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            let names = image.accessibilityCustomActions()?.map(\.name) ?? []
            XCTAssertFalse(names.contains("Remove")); XCTAssertFalse(names.contains("Replace"))
            XCTAssertTrue(names.contains("Select")); XCTAssertFalse(remove.handler?() ?? true)
            XCTAssertTrue(view.structureAccessibility.focus(direction: 1))
        }
    }
    func testExtensionUnknownAndMathExposeHonestLabelsAndActions() async throws {
        try await fixture { view, _ in
            XCTAssertGreaterThanOrEqual(view.extensions.views.count, 3)
            XCTAssertNotNil(try self.atom(view).renderer)
            for atom in view.extensions.views.values {
                XCTAssertEqual(atom.accessibilityRole(), .group)
                XCTAssertTrue(atom.accessibilityLabel()?.hasPrefix(atom.descriptor.type + ":") == true)
                XCTAssertTrue(atom.accessibilityLabel()!.count <= atom.descriptor.type.count + 258)
                XCTAssertTrue(atom.accessibilityCustomActions()?.contains { $0.name == "Select atom" } == true)
                XCTAssertTrue(atom.accessibilityPerformPress())
            }
            XCTAssertTrue(view.extensions.views.values.contains { $0.diagnostic.contains("source") || $0.diagnostic.contains("Source") })
        }
    }
    func testExtensionAXEditUsesSharedCapturedSourceGateAndCancel() async throws {
        try await fixture { view, window in
            let atom = try self.atom(view)
            XCTAssertTrue(atom.accessibilityPerformPress())
            let edit = try self.action("Edit source", atom.accessibilityCustomActions())
            XCTAssertTrue(edit.handler?() == true)
            for _ in 0..<100 where !atom.sourceView.isEditable { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(atom.sourceView.isEditable); XCTAssertTrue(window.firstResponder === atom.sourceView)
            let cancel = try self.action("Cancel", atom.accessibilityCustomActions())
            XCTAssertTrue(cancel.handler?() == true)
            XCTAssertFalse(atom.sourceView.isEditable)
            _ = try await self.send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            XCTAssertFalse(edit.handler?() ?? true)
        }
    }
    func testPointerFreeForwardRouteTraversesAllSourceFamiliesAndReturns() async throws {
        try await fixture { view, window in
            let next = try self.action("Next structure", view.textView.accessibilityCustomActions())
            let count = view.projection.tableViews.values.reduce(0) { $0 + $1.cells.count } + view.attachments.views.count + view.extensions.views.count
            var seen = Set<ObjectIdentifier>()
            for _ in 0..<count {
                XCTAssertTrue(next.handler?() == true)
                let control = try XCTUnwrap(window.firstResponder as? NSView)
                XCTAssertFalse(control === view.textView); XCTAssertTrue(seen.insert(ObjectIdentifier(control)).inserted)
            }
            XCTAssertEqual(seen.count, count)
            XCTAssertTrue(next.handler?() == true); XCTAssertTrue(window.firstResponder === view.textView)
        }
    }
    func testPointerFreeBackwardAndExplicitReturnPreserveRevision() async throws {
        try await fixture { view, window in
            let revision = view.projection.revision
            XCTAssertTrue(view.structureAccessibility.focus(direction: -1))
            XCTAssertFalse(window.firstResponder === view.textView)
            let back = try self.action("Return to editor", view.textView.accessibilityCustomActions())
            XCTAssertTrue(back.handler?() == true); XCTAssertTrue(window.firstResponder === view.textView)
            XCTAssertEqual(view.projection.revision, revision)
        }
    }
    func testReadOnlyCellFocusAndTabExitRemainAvailable() async throws {
        try await fixture { view, window in
            _ = try await self.send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            let table = try self.table(view)
            let last = try XCTUnwrap(table.cells.values.max { ($0.coordinate.row, $0.coordinate.column) < ($1.coordinate.row, $1.coordinate.column) })
            XCTAssertFalse(last.isEditable); XCTAssertTrue(last.accessibilityPerformPress())
            last.doCommand(by: #selector(NSTextView.insertTab(_:)))
            XCTAssertTrue(window.firstResponder === view.textView)
        }
    }
    func testAnnouncementsAreCoalescedBoundedAndDuplicateSuppressed() async throws {
        try await fixture { view, _ in
            let image = try self.image(view)
            XCTAssertTrue(image.accessibilityPerformPress())
            for index in 0..<50 { image.setState(.failed(String(repeating: "🦀", count: 300) + String(index))) }
            await self.turn()
            XCTAssertEqual(view.structureAccessibility.announcementCount, 1)
            XCTAssertLessThanOrEqual(try XCTUnwrap(view.structureAccessibility.lastAnnouncement).count, 256)
            view.structureAccessibility.refreshAnnouncement(); await self.turn()
            XCTAssertEqual(view.structureAccessibility.announcementCount, 1)
            image.setState(.ready); await self.turn()
            XCTAssertEqual(view.structureAccessibility.announcementCount, 2)
        }
    }
    func testDetachedAccessibilityObjectsAndActionsCannotOperateAfterDisposal() async throws {
        try await fixture { view, _ in
            let table = try self.table(view)
            let cell = try XCTUnwrap(table.accessibilityCell(forColumn: 0, row: 0) as? NativeAccessibleCell)
            let image = try self.image(view)
            let action = try self.action("Select", image.accessibilityCustomActions())
            let next = try self.action("Next structure", view.textView.accessibilityCustomActions())
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            XCTAssertFalse(cell.accessibilityPerformPress()); XCTAssertNil(cell.control)
            XCTAssertTrue(table.accessibilityRows()?.isEmpty == true)
            XCTAssertFalse(action.handler?() ?? true); XCTAssertFalse(next.handler?() ?? true)
            view.structureAccessibility.refreshAnnouncement(); await self.turn()
            XCTAssertNil(view.structureAccessibility.lastAnnouncement)
        }
    }
    func testQueriesRemainNativeDuringReentrantTextStorageEditing() async throws {
        try await fixture { view, _ in
            let table = try self.table(view, spans: true)
            view.textView.textStorage?.beginEditing()
            defer { view.textView.textStorage?.endEditing() }
            for _ in 0..<25 {
                XCTAssertEqual(table.accessibilityRows()?.count, table.rowCount)
                XCTAssertNotNil(table.accessibilityCell(forColumn: 0, row: 0))
                XCTAssertNotNil(try self.image(view).accessibilityCustomActions())
                XCTAssertNotNil(try self.atom(view).accessibilityLabel())
            }
        }
    }
    func testNativeKeyboardEquivalentTraversesStructureWithoutEditing() async throws {
        try await fixture { view, window in
            let revision = view.projection.revision
            let right = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: [.control, .command], timestamp: 0, windowNumber: window.windowNumber,
                context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 124))
            XCTAssertTrue(window.performKeyEquivalent(with: right))
            XCTAssertTrue(window.firstResponder is NativeTableCellView)
            XCTAssertTrue(window.performKeyEquivalent(with: right))
            XCTAssertTrue(window.firstResponder is NativeTableCellView)
            XCTAssertEqual(view.projection.revision, revision)
        }
    }
    func testActualSharedTableRemovalDetachesAXCellAndOrphanRow() async throws {
        try await fixture { view, window in
            let table = try self.table(view)
            let index = table.rowCount - 1
            let old = try XCTUnwrap(table.accessibilityCell(forColumn: 0, row: index) as? NativeAccessibleCell)
            let row = try XCTUnwrap(table.accessibilityRows()?.last as? NSAccessibilityElement)
            XCTAssertTrue(old.accessibilityPerformPress())
            let result: Result<Void, NativeCommandFailure> = await withCheckedContinuation { c in
                view.commands.onResult = { result in view.commands.onResult = nil; c.resume(returning: result) }
                view.tables.performStructure(tableID: table.nodeID, action: .deleteRow, index: index)
            }
            try result.get()
            XCTAssertEqual(table.rowCount, index)
            XCTAssertNil(old.control); XCTAssertNil(row.accessibilityParent())
            XCTAssertTrue(row.accessibilityChildren()?.isEmpty == true)
            XCTAssertTrue(window.firstResponder === view.textView)
        }
    }
    func testFocusedImageAXRemovalCommitsOnceAndSharedUndoRestoresRelationships() async throws {
        try await fixture { view, _ in
            let image = try self.image(view), id = image.nodeID
            XCTAssertTrue(image.accessibilityPerformPress())
            let remove = try self.action("Remove", image.accessibilityCustomActions())
            let result: Result<Void, NativeCommandFailure> = await withCheckedContinuation { c in
                view.commands.onResult = { result in view.commands.onResult = nil; c.resume(returning: result) }
                XCTAssertTrue(remove.handler?() == true)
            }
            try result.get()
            XCTAssertNil(view.attachments.views[id]); XCTAssertNil(image.window)
            XCTAssertFalse(remove.handler?() ?? true)
            XCTAssertTrue(view.structureAccessibility.focus(direction: 0))
            let undo: Result<Void, NativeCommandFailure> = await withCheckedContinuation { c in
                view.commands.onResult = { result in view.commands.onResult = nil; c.resume(returning: result) }
                view.commands.perform(.undo)
            }
            try undo.get()
            let restored = try XCTUnwrap(view.attachments.views[id])
            XCTAssertFalse(restored === image)
            XCTAssertEqual(restored.accessibilityLabel(), image.accessibilityLabel())
        }
    }
}
