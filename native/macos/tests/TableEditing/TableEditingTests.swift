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
    private func fixture(_ body: @MainActor (NativeEditorView, [String: Any]) async throws -> Void) async throws {
        _ = NSApplication.shared
        guard let path = ProcessInfo.processInfo.environment["EDITAC_MACOS_TABLE_FIXTURE"] else {
            XCTFail("Missing actual Rust/SQLite table fixture; no DTO or skip substitute"); throw FixtureError()
        }
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
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

    func testNativeFocusTraversesCellsAndLeavesTableWithoutMutation() async throws {
        try await fixture { view, manifest in
            let table = try self.table(view, manifest)
            let first = try self.cell(table, 0, 0), second = try self.cell(table, 0, 1)
            XCTAssertTrue(view.tables.focus(first)); XCTAssertTrue(view.tables.ownsFirstResponder)
            XCTAssertTrue(view.tables.move(from: first, forward: true))
            XCTAssertTrue(view.window?.firstResponder === second)
            XCTAssertTrue(view.tables.move(from: second, forward: false))
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
            XCTAssertEqual(values[0]["target"] as? String, manifest["table"] as? String)
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
            let cell = try self.cell(self.table(view, manifest, rich: true), 0, 0)
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

}
