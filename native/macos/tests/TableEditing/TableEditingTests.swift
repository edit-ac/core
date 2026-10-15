import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureError: Error {}

@MainActor
final class TableEditingTests: XCTestCase {
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { c in
            do { try view.session.submit(request) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }
    private func read(_ view: NativeEditorView) async throws -> NativeSessionRead {
        guard case let .snapshot(read) = try await send(view, .read(now: 0)) else { throw FixtureError() }
        return read
    }
    private func commands(_ view: NativeEditorView, _ values: [[String: Any]]) async throws {
        let snapshot = try await read(view)
        let json = String(data: try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]), encoding: .utf8)!
        _ = try await send(view, .commandBatch(revision: snapshot.revision!, json: json, origin: UUID().uuidString, now: 0))
        XCTAssertNil(view.projectionFailure)
    }
    private func fixture(unmerged: Bool = false, _ body: @MainActor (NativeEditorView, [String: Any]) async throws -> Void) async throws {
        _ = NSApplication.shared
        guard let path = ProcessInfo.processInfo.environment["EDITAC_MACOS_TABLE_FIXTURE"] else {
            XCTFail("Missing actual Rust/SQLite table fixture; no DTO or skip substitute"); throw FixtureError()
        }
        var manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        if unmerged {
            manifest["path"] = manifest["unmergedPath"]; manifest["table"] = manifest["unmergedTable"]
            manifest["richTable"] = manifest["unmergedRichTable"]
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-tables-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = directory.appendingPathComponent("document.sqlite")
        try FileManager.default.copyItem(atPath: manifest["path"] as! String, toPath: store.path)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 640, height: 1100))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: directory) }
        do {
            let options = NativeSessionOptions(path: store.path, documentId: manifest["documentId"] as! String,
                epoch: manifest["epoch"] as! String, writable: true, permissionExpiresAt: nil)
            let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
                do { try view.session.open(options: options, now: 0) { c.resume(with: $0.mapError { $0 as Error }) } }
                catch { c.resume(throwing: error) }
            }
            XCTAssertNil(view.projectionFailure)
            try await body(view, manifest)
        } catch {
            await withCheckedContinuation { c in view.dispose { c.resume() } }; throw error
        }
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }
    private func table(_ view: NativeEditorView, _ manifest: [String: Any], rich: Bool = false) throws -> NativeTableView {
        try XCTUnwrap(view.projection.tableViews[manifest[rich ? "richTable" : "table"] as! String])
    }
    private func cell(_ table: NativeTableView, _ row: Int, _ column: Int) throws -> NativeTableCellView {
        try XCTUnwrap(table.cells[NativeCellCoordinate(row: row, column: column)])
    }

    // One canonical actual-AppKit / serialized generated Swift / SQLite harness.
    // The nested fixture creates a distinct store from the same checkpoint.
    private func enable(_ view: NativeEditorView) async throws {
        view.commands.now = { 0 }
        _ = try await send(view, .tablePolicy(enabled: true))
        _ = try await read(view)
        view.window?.makeKeyAndOrderFront(nil)
        XCTAssertTrue(view.window?.isKeyWindow == true)
    }
    private func perform(_ view: NativeEditorView, _ action: () throws -> Void) async throws {
        defer { view.commands.onResult = nil }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            view.commands.onResult = { c.resume(with: $0.mapError { $0 as Error }) }
            do { try action() } catch { view.commands.onResult = nil; c.resume(throwing: error) }
        }
        XCTAssertNil(view.projectionFailure)
    }
    private func updates(_ view: NativeEditorView) async throws -> [NativeSessionPeerUpdate] {
        guard case let .peerUpdates(values) = try await send(view, .pendingUpdates) else { throw FixtureError() }
        return values
    }
    private func receive(_ view: NativeEditorView, _ entry: NativeSessionPeerUpdate) async throws {
        // Prepared authority admits this exact owned entry; no network/crypto claim.
        _ = try await send(view, .reservePeerWriter(entry.writer))
        let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            do { try view.session.receivePeer(entry, admitting: { candidate in
                guard candidate == entry else { throw FixtureError() }
            }) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }

    func testNativeFocusTraversesCellsAndLeavesTableWithoutMutation() async throws {
        try await fixture { view, manifest in
            let table = try self.table(view, manifest)
            let first = try self.cell(table, 0, 0), second = try self.cell(table, 0, 1)
            XCTAssertTrue(view.tables.focus(first)); XCTAssertTrue(view.tables.ownsFirstResponder)
            first.doCommand(by: #selector(NSTextView.insertTab(_:)))
            XCTAssertTrue(view.window?.firstResponder === second)
            second.doCommand(by: #selector(NSTextView.insertBacktab(_:)))
            XCTAssertTrue(view.window?.firstResponder === first)
            XCTAssertTrue(view.tables.move(from: first, forward: false))
            XCTAssertTrue(view.window?.firstResponder === view.textView)
            XCTAssertEqual(table.cells.count, 6)
        }
    }
    func testAccessibleFocusAndSpanNavigationUseRealChildControls() async throws {
        try await fixture { view, manifest in
            let table = try self.table(view, manifest, rich: true)
            let first = try self.cell(table, 0, 0), next = try self.cell(table, 0, 1)
            XCTAssertTrue(first.accessibilityPerformPress())
            XCTAssertTrue(view.tables.move(from: first, forward: true))
            XCTAssertTrue(view.window?.firstResponder === next)
            XCTAssertNil(table.cells[.init(row: 0, column: 2)])
            XCTAssertTrue(view.tables.move(from: try self.cell(table, 1, 2), forward: true))
            XCTAssertTrue(view.window?.firstResponder === view.textView)
        }
    }
    func testCapturedUnicodeReplacementBuildsExactPortableRequest() async throws {
        try await fixture { view, manifest in
            let cell = try self.cell(self.table(view, manifest), 0, 0)
            let target = try view.tables.capture(cell)
            let json = try view.tables.command(target: target, range: NSRange(location: 7, length: 2), replacement: "שלום")
            let values = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]]
            XCTAssertEqual(values[0]["type"] as? String, "tableCell")
            XCTAssertEqual(values[0]["text"] as? String, "Header שלום")
            XCTAssertEqual(values[0]["owner"] as? String, manifest["table"] as? String)
            XCTAssertEqual(cell.string, "Header 🦀")
        }
    }
    func testInvalidScalarRangeAndMultilineNeverProduceCommand() async throws {
        try await fixture { view, manifest in
            let target = try view.tables.capture(self.cell(self.table(view, manifest), 0, 0))
            for (range, replacement) in [(NSRange(location: 8, length: 0), "a"),
                (NSRange(location: 100, length: 0), "a"), (NSRange(location: 0, length: 0), "a\nb")] {
                XCTAssertThrowsError(try view.tables.command(target: target, range: range, replacement: replacement))
            }
        }
    }
    func testUnavailablePolicyRejectsDelegateWithoutNativeMutation() async throws {
        try await fixture { view, manifest in
            let cell = try self.cell(self.table(view, manifest), 0, 0)
            XCTAssertFalse(cell.isEditable); XCTAssertFalse(cell.allowsUndo)
            let old = cell.attributedString().copy() as! NSAttributedString
            XCTAssertFalse(view.tables.textView(cell, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementString: "bad"))
            XCTAssertEqual(view.tables.lastFailure, .unavailable)
            XCTAssertTrue(cell.attributedString().isEqual(to: old))
            XCTAssertNil(view.commands.catalog?.routes.first(where: { $0.id == "tableCell" && $0.available }))
        }
    }
    func testRealSessionDeniesTableCommandAndRetainsRevisionAndHistory() async throws {
        try await fixture { view, manifest in
            let before = try await self.read(view)
            let cell = try self.cell(self.table(view, manifest), 0, 0)
            let json = try view.tables.command(target: view.tables.capture(cell), range: NSRange(location: 0, length: 0), replacement: "X")
            do {
                _ = try await self.send(view, .commandBatch(revision: before.revision!, json: json, origin: "table-denial", now: 0))
                XCTFail("Disabled shared table policy must reject")
            } catch { }
            let after = try await self.read(view)
            XCTAssertEqual(before.revision, after.revision)
            XCTAssertEqual(cell.string, "Header 🦀")
            XCTAssertFalse(view.commands.history?.canUndo ?? true)
            XCTAssertTrue(cell === view.projection.tableViews[manifest["table"] as! String]?.cells[cell.coordinate])
        }
    }
    func testRemoteRevisionInvalidatesCapturedCellWithoutChangingControlIdentity() async throws {
        try await fixture { view, manifest in
            let table = try self.table(view, manifest), cell = try self.cell(self.table(view, manifest), 0, 0)
            let target = try view.tables.capture(cell)
            cell.setSelectedRange(NSRange(location: 1, length: 2))
            let step = (manifest["steps"] as! [[String: Any]])[0]
            let patch = String(data: try JSONSerialization.data(withJSONObject: step["patch"]!), encoding: .utf8)!
            XCTAssertEqual(step["localReceipt"] as? Bool, true)
            try view.projection.apply(NativeProjectionUpdate(snapshot: nil,
                patches: NativeSessionPatches(revision: Data((step["revision"] as! [NSNumber]).map { $0.uint8Value }),
                afterSequence: 0, sequence: 1, patchesJson: [patch]), selection: []))
            XCTAssertTrue(table === view.projection.tableViews[table.nodeID]); XCTAssertTrue(cell === table.cells[cell.coordinate])
            XCTAssertEqual(cell.selectedRange(), NSRange(location: 1, length: 2))
            XCTAssertThrowsError(try view.tables.command(target: target, range: NSRange(location: 0, length: 0), replacement: "stale"))
        }
    }
    func testReadOnlyAndDisposalRejectRetainedCellAndHistory() async throws {
        try await fixture { view, manifest in
            let cell = try self.cell(self.table(view, manifest), 0, 0)
            let target = try view.tables.capture(cell)
            _ = try await self.send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            _ = try await self.read(view)
            XCTAssertFalse(cell.isEditable)
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            XCTAssertFalse(view.tables.focus(cell))
            XCTAssertFalse(view.tables.move(from: cell, forward: true))
            XCTAssertThrowsError(try view.tables.capture(cell))
            XCTAssertThrowsError(try view.tables.command(target: target, range: NSRange(location: 0, length: 0), replacement: "late"))
        }
    }
    func testRichCellEditIsExplicitlyUnsupportedRatherThanFlattened() async throws {
        try await fixture { view, manifest in
            let cell = try self.cell(self.table(view, manifest, rich: true), 1, 2)
            XCTAssertThrowsError(try view.tables.capture(cell)) { XCTAssertEqual($0 as? NativeTableEditingFailure, .unsupportedCell) }
            XCTAssertFalse(cell.isEditable)
        }
    }
    func testNativeFormattingAndHistoryMenusCannotMutateCellLocally() async throws {
        try await fixture { view, manifest in
            let cell = try self.cell(self.table(view, manifest), 0, 0)
            XCTAssertTrue(view.tables.focus(cell))
            let before = cell.attributedString().copy() as! NSAttributedString
            cell.selectAll(nil); cell.toggleBoldface(nil); cell.alignCenter(nil); cell.underline(nil)
            XCTAssertTrue(cell.attributedString().isEqual(to: before))
            let menu = NSMenuItem(title: "Undo", action: NSSelectorFromString("undo:"), keyEquivalent: "z")
            XCTAssertFalse(cell.validateMenuItem(menu))
            let format = NSMenuItem(title: "Bold", action: NSSelectorFromString("toggleBoldface:"), keyEquivalent: "b")
            XCTAssertFalse(cell.validateMenuItem(format))
            XCTAssertEqual(view.commands.availability(.bold), .unfocused)
            XCTAssertEqual(view.commands.availability(.copy), .unfocused)
            XCTAssertFalse(view.tables.historyAvailable(redo: false))
        }
    }

    func testPreparedCellProjectionClampsSelectionAtScalarBoundaryAndPreservesFocus() async throws {
        try await fixture { view, manifest in
            let table = try self.table(view, manifest), cell = try self.cell(self.table(view, manifest), 0, 0)
            XCTAssertTrue(view.tables.focus(cell))
            cell.setSelectedRange(NSRange(location: 2, length: 0), affinity: .upstream, stillSelecting: false)
            var tuple = table.sharedTuple
            var data = tuple[2] as! [String: Any], rows = data["rows"] as! [[Any]]
            rows[0][0] = [["A🦀Z", []]]; data["rows"] = rows; tuple[2] = data
            // Prepared geometry/content case only, not a shared command success.
            try table.update(NativeTableDescriptor(tuple))
            XCTAssertEqual(cell.selectedRange(), NSRange(location: 1, length: 0))
            XCTAssertEqual(cell.selectionAffinity, .upstream)
            XCTAssertTrue(view.window?.firstResponder === cell)
            table.dispose()
            XCTAssertTrue(view.window?.firstResponder === view.textView)
            XCTAssertFalse(view.tables.focus(cell))
        }
    }

    func testActualNativeV1DelegateCommitPreservesMarksSelectionAndSharedHistory() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let table = try self.table(view, manifest), cell = try self.cell(table, 0, 0)
            XCTAssertTrue(cell.isEditable); XCTAssertFalse(cell.allowsUndo)
            XCTAssertTrue(view.tables.focus(cell))
            cell.setSelectedRange(NSRange(location: 7, length: 2))
            let before = try await self.read(view)
            try await self.perform(view) {
                cell.insertText("שלום", replacementRange: NSRange(location: 7, length: 2))
            }
            XCTAssertEqual(cell.string, "Header שלום")
            XCTAssertEqual(cell.selectedRange(), NSRange(location: 11, length: 0))
            XCTAssertTrue(view.window?.firstResponder === cell)
            XCTAssertTrue(cell === table.cells[cell.coordinate])
            let after = try await self.read(view)
            XCTAssertNotEqual(before.revision, after.revision)
            let entries = try await self.updates(view)
            XCTAssertEqual(entries.count, 1)
            XCTAssertTrue(view.tables.historyAvailable(redo: false))
            try await self.perform(view) { cell.undo(nil) }
            XCTAssertEqual(cell.string, "Header 🦀")
            try await self.perform(view) { cell.redo(nil) }
            XCTAssertEqual(cell.string, "Header שלום")
            XCTAssertTrue(cell === table.cells[cell.coordinate]); XCTAssertFalse(cell.allowsUndo)
            let tuple = table.sharedTuple[2] as! [String: Any]
            let rows = tuple["rows"] as! [[Any]], runs = rows[0][0] as! [[Any]]
            XCTAssertEqual((runs[0][1] as! [[String]])[0], ["bold"])
        }
    }
    func testActualV2CellCommitRetainsHeaderSpanStyleAndOtherBlocks() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let table = try self.table(view, manifest, rich: true), cell = try self.cell(table, 0, 0)
            XCTAssertTrue(view.tables.focus(cell)); XCTAssertTrue(cell.isEditable)
            let before = table.sharedTuple[2] as! [String: Any]
            try await self.perform(view) { try view.tables.replace(target: view.tables.capture(cell),
                range: NSRange(location: 0, length: cell.string.utf16.count), replacement: "Native 🦀") }
            XCTAssertEqual(cell.string, "Native 🦀"); XCTAssertTrue(cell.isHeaderCell); XCTAssertEqual(cell.rowSpan, 2)
            let after = table.sharedTuple[2] as! [String: Any]
            let oldRows = before["rows"] as! [[Any]], rows = after["rows"] as! [[Any]]
            XCTAssertTrue(NSDictionary(dictionary: oldRows[1][2] as! [String: Any]).isEqual(to: rows[1][2] as! [String: Any]))
            let entry = rows[0][0] as! [String: Any], paragraphs = entry["paragraphs"] as! [[String: Any]]
            XCTAssertEqual(paragraphs[0]["style"] as? [AnyHashable], ["heading", 2])
            XCTAssertFalse(try self.cell(table, 1, 2).isEditable)
            try await self.perform(view) { cell.undo(nil) }; XCTAssertEqual(cell.string, "Title😀")
        }
    }
    func testActualV1AndV2FourStructuralActionsUseNativeControlsAndUndo() async throws {
        for rich in [false, true] {
            try await fixture(unmerged: rich) { view, manifest in
                try await self.enable(view)
                let table = try self.table(view, manifest, rich: rich), first = try self.cell(table, 0, 0)
                XCTAssertTrue(view.tables.focus(first))
                for (action, index, rows, columns) in [
                    (NativeTableStructureAction.insertRow, 2, 3, 3), (.deleteRow, 2, 2, 3),
                    (.insertColumn, 3, 2, 4), (.deleteColumn, 3, 2, 3)] {
                    let button = view.tables.makeStructureButton(tableID: table.nodeID, action: action, index: index, title: action.rawValue)
                    try await self.perform(view) { button.performClick(nil) }
                    XCTAssertEqual(table.rowCount, rows); XCTAssertEqual(table.columnCount, columns)
                    XCTAssertTrue(first === table.cells[first.coordinate]); XCTAssertTrue(view.window?.firstResponder === first)
                    XCTAssertEqual(table.sharedTuple[1] as? Int, rich ? 2 : 1)
                    try await self.perform(view) { first.undo(nil) }
                    try await self.perform(view) { first.redo(nil) }
                    XCTAssertEqual(table.rowCount, rows); XCTAssertEqual(table.columnCount, columns)
                }
            }
        }
    }
    func testActualUnsupportedStructureAndBoundsRejectWithoutMutation() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let table = try self.table(view, manifest, rich: true), first = try self.cell(table, 0, 0)
            XCTAssertTrue(view.tables.focus(first))
            let revision = try await self.read(view).revision
            for (id, action, index) in [(table.nodeID, NativeTableStructureAction.insertRow, 0),
                (manifest["table"] as! String, .deleteColumn, 99)] {
                let target = try view.tables.captureStructure(tableID: id)
                let json = try view.tables.structureCommand(target: target, action: action, index: index)
                do { try await view.commands.check(commandsJSON: json); XCTFail("Unsupported target must reject") } catch { }
            }
            let after = try await self.read(view), entries = try await self.updates(view)
            XCTAssertEqual(revision, after.revision)
            XCTAssertEqual(entries.count, 0)
        }
    }
    func testActualRemoteCellAndStructurePreserveNativeIdentityAndLocalUndo() async throws {
        for (rich, structure) in [(false, false), (false, true), (true, false), (true, true)] {
            try await fixture(unmerged: rich) { local, manifest in
                try await self.enable(local)
                let table = try self.table(local, manifest, rich: rich), first = try self.cell(table, 0, 0)
                XCTAssertTrue(local.tables.focus(first))
                let originalText = first.string
                try await self.perform(local) { try local.tables.replace(target: local.tables.capture(first), range: NSRange(location: 0, length: 0), replacement: "LOCAL ") }
                try await self.fixture(unmerged: rich) { peer, peerManifest in
                    try await self.enable(peer)
                    let peerTable = try self.table(peer, peerManifest, rich: rich), peerCell = try self.cell(peerTable, 0, 1)
                    XCTAssertTrue(peer.tables.focus(peerCell))
                    if structure {
                        try await self.perform(peer) { peer.tables.performStructure(tableID: peerTable.nodeID, action: .insertRow, index: 2) }
                    } else {
                        try await self.perform(peer) { try peer.tables.replace(target: peer.tables.capture(peerCell), range: NSRange(location: 0, length: peerCell.string.utf16.count), replacement: "REMOTE 🦀") }
                    }
                    let stale = try local.tables.capture(first)
                    first.setSelectedRange(NSRange(location: 1, length: 2), affinity: .upstream, stillSelecting: false)
                    let entries = try await self.updates(peer)
                    let entry = try XCTUnwrap(entries.last)
                    try await self.receive(local, entry)
                    let receipt = try XCTUnwrap(local.session.storageStatus.receipt)
                    XCTAssertEqual(receipt.writer, entry.writer); XCTAssertEqual(receipt.sequence, entry.sequence)
                    XCTAssertEqual(receipt.checksum, entry.checksum); XCTAssertEqual(receipt.durability, .processCrash)
                    XCTAssertTrue(table === local.projection.tableViews[table.nodeID]); XCTAssertTrue(first === table.cells[first.coordinate])
                    XCTAssertEqual(first.selectedRange(), NSRange(location: 1, length: 2)); XCTAssertEqual(first.selectionAffinity, .upstream)
                    XCTAssertThrowsError(try local.tables.command(target: stale, range: .init(location: 0, length: 0), replacement: "stale"))
                    XCTAssertEqual(table.rowCount, structure ? 3 : 2)
                    if !structure { XCTAssertEqual(try self.cell(table, 0, 1).string, "REMOTE 🦀") }
                    local.window?.makeKeyAndOrderFront(nil); XCTAssertTrue(local.tables.focus(first))
                    try await self.perform(local) { first.undo(nil) }
                    XCTAssertEqual(first.string, originalText)
                    XCTAssertEqual(table.rowCount, structure ? 3 : 2)
                    if !structure { XCTAssertEqual(try self.cell(table, 0, 1).string, "REMOTE 🦀") }
                    try await self.perform(local) { first.redo(nil) }; XCTAssertEqual(first.string, "LOCAL " + originalText)
                }
            }
        }
    }
    func testUntrustedJournalRejectedBeforeAdmissionAndReadonlyDeniesNativeActions() async throws {
        try await fixture { local, manifest in
            try await self.enable(local)
            try await self.fixture { peer, peerManifest in
                try await self.enable(peer)
                let cell = try self.cell(self.table(peer, peerManifest), 0, 0)
                XCTAssertTrue(peer.tables.focus(cell))
                try await self.perform(peer) { try peer.tables.replace(target: peer.tables.capture(cell), range: .init(location: 0, length: 0), replacement: "peer") }
                let entries = try await self.updates(peer)
                    let entry = try XCTUnwrap(entries.last)
                let revision = try await self.read(local).revision
                XCTAssertThrowsError(try local.session.receivePeer(entry, admitting: { _ in throw FixtureError() }))
                let after = try await self.read(local)
                XCTAssertEqual(revision, after.revision)
                XCTAssertFalse(after.recoveryRequired)
                _ = try await self.send(local, .commandPermission(writable: false, expiresAt: nil, now: 0))
                let localCell = try self.cell(self.table(local, manifest), 0, 0)
                XCTAssertFalse(localCell.isEditable)
                local.window?.makeKeyAndOrderFront(nil); XCTAssertTrue(local.tables.focus(localCell))
                do { try await self.perform(local) { try local.tables.replace(target: local.tables.capture(localCell), range: .init(location: 0, length: 0), replacement: "denied") }; XCTFail("readonly") } catch { }
                try await self.receive(local, entry)
                XCTAssertEqual(localCell.string, "peerHeader 🦀")
                XCTAssertFalse(localCell.isEditable)
            }
        }
    }

}
