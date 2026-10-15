import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureError: Error {}

@MainActor
final class TableProjectionTests: XCTestCase {
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
    private func step(_ view: NativeEditorView, _ manifest: [String: Any], through label: String) throws {
        for step in manifest["steps"] as! [[String: Any]] {
            let sequence = (step["sequence"] as! NSNumber).uint64Value
            if sequence <= view.projection.richSequence! { continue }
            let patch = String(data: try JSONSerialization.data(withJSONObject: step["patch"]!, options: [.sortedKeys]), encoding: .utf8)!
            // Actual shared Session/EditService/SQLite commit stream and owned
            // observed revision. No transport/reconnect or table-input claim.
            XCTAssertEqual(step["localReceipt"] as? Bool, true)
            try view.projection.apply(NativeProjectionUpdate(snapshot: nil,
                patches: NativeSessionPatches(revision: Data((step["revision"] as! [NSNumber]).map { $0.uint8Value }),
                    afterSequence: sequence - 1, sequence: sequence, patchesJson: [patch]), selection: []))
            self.assertTableFlow(view)
            if step["label"] as? String == label { return }
        }
    }

    private func assertTableFlow(_ view: NativeEditorView, file: StaticString = #filePath, line: UInt = #line) {
        let tables = view.projection.nodes.compactMap { view.projection.tableViews[$0.id] }
        for pair in zip(tables, tables.dropFirst()) {
            XCTAssertGreaterThanOrEqual(pair.1.frame.minY, pair.0.frame.maxY,
                "Separate native tables must not overlap", file: file, line: line)
        }
    }

    private func preparedTuple(_ view: NativeEditorView, table: NativeTableView, tuple: [Any]) throws {
        let sequence = view.projection.richSequence! + 1
        var wire = view.projection.richNodes[table.nodeID]!.wire
        wire["blockAttributes"] = tuple
        let identity = try JSONSerialization.jsonObject(with: view.projection.richIdentity!)
        let patch: [String: Any] = ["version": 1, "sequence": sequence, "identity": identity,
            "projectionError": NSNull(), "nodes": [["type": "visible", "node": wire]]]
        let json = String(data: try JSONSerialization.data(withJSONObject: patch), encoding: .utf8)!
        try view.projection.apply(NativeProjectionUpdate(snapshot: nil,
            patches: NativeSessionPatches(revision: Data("prepared-table-layout".utf8),
                afterSequence: sequence - 1, sequence: sequence, patchesJson: [json]), selection: []))
    }

    func testActualSessionMountsNativeCellsAndRetainsExactTuples() async throws {
        try await fixture { view, manifest in
            XCTAssertEqual(view.projection.tableViews.count, 2)
            self.assertTableFlow(view)
            for rich in [false, true] {
                let t = try self.table(view, manifest, rich: rich)
                XCTAssertTrue(t.superview === view.textView)
                XCTAssertNotNil(t.window)
                XCTAssertEqual(t.rowCount, 2); XCTAssertEqual(t.columnCount, 3)
                XCTAssertEqual(t.cells.count, rich ? 4 : 6)
                let wire = view.projection.richNodes[t.nodeID]!.wire["blockAttributes"] as! [Any]
                XCTAssertTrue(NSArray(array: t.sharedTuple).isEqual(to: wire))
                XCTAssertNotNil(view.projection.attachmentIdentities[t.nodeID]?.attachmentCell as? NativeTableAttachmentCell)
                for c in t.cells.values { XCTAssertTrue(c.superview === t.documentView); XCTAssertFalse(c.allowsUndo) }
            }
            if let root = ProcessInfo.processInfo.environment["EDITAC_MACOS_TABLE_EVIDENCE"] {
                view.displayIfNeeded()
                let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
                view.cacheDisplay(in: view.bounds, to: bitmap)
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: root).appendingPathComponent("native-tables.png"))
            }
            XCTAssertEqual(view.textView.string, "Before\n\u{FFFC}\n\u{FFFC}\nAfter")
        }
    }
    func testActualSessionSnapshotResyncRetainsEveryNativeControl() async throws {
        try await fixture { view, manifest in
            let table = try self.table(view, manifest), cells = table.cells
            _ = try await self.send(view, .resyncProjection)
            XCTAssertNil(view.projectionFailure)
            XCTAssertTrue(try self.table(view, manifest) === table)
            for (key, value) in cells { XCTAssertTrue(table.cells[key] === value) }
            XCTAssertFalse(table.cells.values.contains { $0.isEditable || $0.allowsUndo })
        }
    }
    func testLegacyUnicodeMarksAndLinksUseTheSharedStyleRegistry() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest)
            let header = try self.cell(t, 0, 0)
            XCTAssertEqual(header.string, "Header 🦀")
            let font = try XCTUnwrap(header.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
            XCTAssertTrue(NSFontManager.shared.traits(of: font).contains(.boldFontMask))
            XCTAssertEqual(try self.cell(t, 0, 1).string, "שלום")
            let link = try self.cell(t, 0, 2).textStorage!.attribute(.link, at: 0, effectiveRange: nil) as? URL
            XCTAssertEqual(link?.absoluteString, "https://example.invalid/cell")
            XCTAssertEqual(try self.cell(t, 1, 1).string, "")
        }
    }
    func testRichSpansCoverNativeGeometryWithoutPlaceholderCells() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest, rich: true)
            let a = try self.cell(t, 0, 0), b = try self.cell(t, 0, 1), c = try self.cell(t, 1, 1)
            XCTAssertEqual(a.rowSpan, 2); XCTAssertTrue(a.isHeaderCell)
            XCTAssertEqual(b.columnSpan, 2)
            XCTAssertNil(t.cells[.init(row: 1, column: 0)])
            XCTAssertNil(t.cells[.init(row: 0, column: 2)])
            XCTAssertEqual(a.frame.height, b.frame.height + c.frame.height, accuracy: 1)
            XCTAssertEqual(b.frame.width, c.frame.width * 2, accuracy: 1)
        }
    }
    func testRichParagraphStylesAndMixedMarksAreNativeAttributedText() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest, rich: true)
            let heading = try self.cell(t, 0, 0)
            XCTAssertEqual(heading.string, "Title😀")
            XCTAssertEqual((heading.textStorage!.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, 24)
            let code = try self.cell(t, 1, 1)
            let font = try XCTUnwrap(code.textStorage!.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
            XCTAssertTrue(NSFontManager.shared.traits(of: font).contains(.fixedPitchFontMask))
            let multi = try self.cell(t, 1, 2)
            XCTAssertTrue(multi.string.hasPrefix("RTL שלום\n"))
            let mixed = try self.cell(t, 0, 1).textStorage!
            XCTAssertEqual(mixed.attribute(.underlineStyle, at: 0, effectiveRange: nil) as? Int, 1)
            XCTAssertEqual(mixed.attribute(.strikethroughStyle, at: 0, effectiveRange: nil) as? Int, 1)
        }
    }
    func testActualEngineContentPatchRetainsTableCellAndAttachmentIdentity() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest), cells = t.cells
            let attachment = view.projection.attachmentIdentities[t.nodeID]
            try self.step(view, manifest, through: "cell-content")
            XCTAssertTrue(try self.table(view, manifest) === t)
            XCTAssertTrue(view.projection.attachmentIdentities[t.nodeID] === attachment)
            for (key, value) in cells { XCTAssertTrue(t.cells[key] === value) }
            XCTAssertEqual(try self.cell(t, 1, 0).string, "Updated 🦀 אב")
        }
    }
    func testPreparedDimensionPatchesRetainSurvivingCoordinates() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest), cells = t.cells
            var tuple = t.sharedTuple, data = tuple[2] as! [String: Any], rows = data["rows"] as! [[Any]]
            rows.append(rows[1]); data["rows"] = rows; tuple[2] = data
            try self.preparedTuple(view, table: t, tuple: tuple)
            XCTAssertEqual(t.rowCount, 3); XCTAssertEqual(t.cells.count, 9)
            let removed = try self.cell(t, 2, 0)
            for (key, value) in cells { XCTAssertTrue(t.cells[key] === value) }
            rows.removeLast(); data["rows"] = rows; tuple[2] = data
            try self.preparedTuple(view, table: t, tuple: tuple)
            XCTAssertEqual(t.cells.count, 6); XCTAssertNil(removed.superview)
            for (key, value) in cells { XCTAssertTrue(t.cells[key] === value) }
        }
    }
    func testPrecedingTextPatchRepositionsNativeTableWithoutReplacingIt() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest), before = t.frame
            try self.step(view, manifest, through: "preceding-text")
            XCTAssertGreaterThan(t.frame.minY, before.minY)
            XCTAssertTrue(try self.table(view, manifest) === t)
            let range = view.projection.nodes.first { $0.id == t.nodeID }!.range
            XCTAssertEqual((view.textView.string as NSString).substring(with: range), "\u{FFFC}")
        }
    }
    func testResizeAndHorizontalOverflowKeepEveryControl() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest), cells = t.cells, initial = t.frame.width
            view.frame.size.width = 200
            view.layoutSubtreeIfNeeded(); view.textView.layoutSubtreeIfNeeded()
            view.projection.layoutTables()
            XCTAssertLessThan(t.frame.width, initial)
            XCTAssertGreaterThan(t.documentView!.frame.width, t.frame.width)
            for (key, value) in cells { XCTAssertTrue(t.cells[key] === value) }
            XCTAssertGreaterThan(t.frame.height, 0)
        }
    }
    func testPreparedRichContentPatchRetainsSpannedCellControls() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest, rich: true), cells = t.cells
            var tuple = t.sharedTuple, data = tuple[2] as! [String: Any], rows = data["rows"] as! [[Any]]
            var cell = rows[1][1] as! [String: Any], paragraphs = cell["paragraphs"] as! [[String: Any]]
            var runs = paragraphs[0]["runs"] as! [[Any]]; runs[0][0] = "Rich updated"
            paragraphs[0]["runs"] = runs; cell["paragraphs"] = paragraphs
            rows[1][1] = cell; data["rows"] = rows; tuple[2] = data
            try self.preparedTuple(view, table: t, tuple: tuple)
            XCTAssertEqual(try self.cell(t, 1, 1).string, "Rich updated")
            for (key, value) in cells { XCTAssertTrue(t.cells[key] === value) }
        }
    }
    func testRemovalDisposesNativeHierarchyAndRestoreUsesFreshControls() async throws {
        try await fixture { view, manifest in
            let old = try self.table(view, manifest), c = try self.cell(old, 0, 0)
            let unaffected = try self.table(view, manifest, rich: true)
            try self.step(view, manifest, through: "remove-table")
            XCTAssertNil(view.projection.tableViews[old.nodeID]); XCTAssertNil(old.superview)
            XCTAssertNil(c.superview); XCTAssertTrue(old.cells.isEmpty)
            XCTAssertTrue(try self.table(view, manifest, rich: true) === unaffected)
            try self.step(view, manifest, through: "restore-table")
            XCTAssertFalse(try self.table(view, manifest) === old)
        }
    }
    func testFullActualEnginePatchStreamMatchesSharedVisibleSemantics() async throws {
        try await fixture { view, manifest in
            try self.step(view, manifest, through: "redo-restore")
            let last = (manifest["steps"] as! [[String: Any]]).last!
            let expected = (last["expected"] as! [String: Any])["visible"] as! [[String: Any]]
            XCTAssertEqual(view.projection.richNodes.count, expected.count)
            for node in expected {
                XCTAssertTrue(NSDictionary(dictionary: view.projection.richNodes[node["id"] as! String]!.wire).isEqual(to: node))
            }
        }
    }
    func testDisposalDetachesCellsAndProjectionCannotResurrectThem() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest), c = try self.cell(t, 0, 0)
            XCTAssertFalse(c.isEditable); XCTAssertFalse(c.allowsUndo)
            await withCheckedContinuation { continuation in view.dispose { continuation.resume() } }
            XCTAssertTrue(view.projection.tableViews.isEmpty); XCTAssertNil(t.superview); XCTAssertNil(c.superview)
            XCTAssertThrowsError(try self.step(view, manifest, through: "cell-content"))
        }
    }
    func testPreparedUnsupportedTablePatchIsRejectedBeforeAnyNativeMutation() async throws {
        try await fixture { view, manifest in
            let t = try self.table(view, manifest), before = view.textView.string, cells = t.cells
            var step = (manifest["steps"] as! [[String: Any]])[0]
            var patch = step["patch"] as! [String: Any]
            var changes = patch["nodes"] as! [[String: Any]]
            let index = changes.firstIndex { ($0["node"] as? [String: Any])?["id"] as? String == t.nodeID }!
            var node = changes[index]["node"] as! [String: Any]
            var tuple = node["blockAttributes"] as! [Any]; tuple[1] = 99
            node["blockAttributes"] = tuple; changes[index]["node"] = node; patch["nodes"] = changes
            step["patch"] = patch
            var prepared = manifest; prepared["steps"] = [step]
            XCTAssertThrowsError(try self.step(view, prepared, through: "cell-content"))
            XCTAssertEqual(view.textView.string, before); XCTAssertEqual(view.projection.richSequence, 0)
            for (key, value) in cells { XCTAssertTrue(t.cells[key] === value) }
        }
    }
}
