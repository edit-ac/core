import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureError: Error {}

@MainActor
final class StylesTests: XCTestCase {
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
        guard let path = ProcessInfo.processInfo.environment["EDITAC_MACOS_STYLE_FIXTURE"] else {
            XCTFail("Missing actual Rust/SQLite style fixture; no DTO or skip substitute"); throw FixtureError()
        }
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-styles-" + UUID().uuidString)
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
    private func node(_ view: NativeEditorView, _ text: String) throws -> NativeTextNodeProjection {
        try XCTUnwrap(view.projection.nodes.first { $0.text == text })
    }
    private func attributes(_ view: NativeEditorView, _ text: String) throws -> [NSAttributedString.Key: Any] {
        let node = try node(view, text)
        return view.textView.textStorage!.attributes(at: node.range.location, effectiveRange: nil)
    }
    private func paragraph(_ view: NativeEditorView, _ text: String) throws -> NSParagraphStyle {
        try XCTUnwrap(try attributes(view, text)[.paragraphStyle] as? NSParagraphStyle)
    }
    private func traits(_ attributes: [NSAttributedString.Key: Any]) throws -> NSFontTraitMask {
        NSFontManager.shared.traits(of: try XCTUnwrap(attributes[.font] as? NSFont))
    }

    func testCorpusPreservesExactSharedSemanticsAndIdentity() async throws {
        try await fixture { view, manifest in
            let expected = manifest["expected"] as! [String: Any]
            let visible = expected["visible"] as! [[String: Any]]
            XCTAssertEqual(view.projection.richNodes.count, visible.count)
            for wire in visible {
                let actual = try XCTUnwrap(view.projection.richNodes[wire["id"] as! String])
                XCTAssertTrue(NSDictionary(dictionary: wire).isEqual(to: actual.wire))
                if actual.kind == "block", !actual.text.isEmpty {
                    let p = try node(view, actual.text)
                    let retained = view.textView.textStorage!.attribute(NativeTextProjection.sharedNodeAttributes,
                        at: p.range.location, effectiveRange: nil) as! NSDictionary
                    XCTAssertTrue(retained.isEqual(to: wire))
                    var offset = p.range.location
                    for run in actual.runs {
                        let length = (run["text"] as! String).utf16.count
                        if length > 0 {
                            let retained = view.textView.textStorage!.attribute(NativeTextProjection.sharedRunAttributes,
                                at: offset, effectiveRange: nil) as! NSDictionary
                            XCTAssertTrue(retained.isEqual(to: run["attributes"] as! [String: Any]))
                        }
                        offset += length
                    }
                }
            }
            XCTAssertFalse(view.textView.allowsUndo)
            let read = try await self.read(view)
            XCTAssertEqual(read.nodes.filter { $0.kind == "block" }.map(\.text), view.projection.nodes.map(\.text))
        }
    }
    func testEveryStandardMarkMapsToNativeAttributes() async throws {
        try await fixture { v, _ in
            XCTAssertTrue(try self.traits(self.attributes(v, "bold")).contains(.boldFontMask))
            XCTAssertTrue(try self.traits(self.attributes(v, "italic")).contains(.italicFontMask))
            XCTAssertEqual(try self.attributes(v, "underline")[.underlineStyle] as? Int, NSUnderlineStyle.single.rawValue)
            XCTAssertEqual(try self.attributes(v, "strike")[.strikethroughStyle] as? Int, NSUnderlineStyle.single.rawValue)
            XCTAssertTrue(try self.traits(self.attributes(v, "code")).contains(.fixedPitchFontMask))
            XCTAssertEqual(try self.attributes(v, "link")[.link] as? URL, URL(string: "https://example.invalid/style"))
        }
    }
    func testMixedUnicodeRunsAndLinksKeepTheirBoundaries() async throws {
        try await fixture { v, _ in
            let n = try self.node(v, "bold linked אב plain")
            let storage = v.textView.textStorage!
            let linked = storage.attributes(at: n.range.location + 4, effectiveRange: nil)
            XCTAssertTrue(try self.traits(linked).contains([.boldFontMask, .italicFontMask]))
            XCTAssertNotNil(linked[.link])
            let plain = storage.attributes(at: NSMaxRange(n.range) - 1, effectiveRange: nil)
            XCTAssertNil(plain[.link]); XCTAssertFalse(try self.traits(plain).contains(.boldFontMask))
            XCTAssertEqual((v.textView.string as NSString).substring(with: n.range), n.text)
        }
    }
    func testAllHeadingLevelsUseNativeFontsAndParagraphs() async throws {
        try await fixture { v, _ in
            var sizes: [CGFloat] = []
            for level in 1...6 {
                let attributes = try self.attributes(v, "Heading \(level)")
                XCTAssertTrue(try self.traits(attributes).contains(.boldFontMask))
                sizes.append((attributes[.font] as! NSFont).pointSize)
                XCTAssertGreaterThan(try self.paragraph(v, "Heading \(level)").paragraphSpacing, 4)
            }
            XCTAssertEqual(sizes, sizes.sorted(by: >)); XCTAssertEqual(Set(sizes).count, 6)
        }
    }
    func testCodeToParagraphAndUndoClearStalePresentation() async throws {
        try await fixture { v, _ in
            let text = "let crab = \"🦀\"", n = try self.node(v, "let crab = \"🦀\"")
            XCTAssertTrue(try self.traits(self.attributes(v, text)).contains(.fixedPitchFontMask))
            XCTAssertNotNil(try self.attributes(v, text)[.backgroundColor])
            try await self.commands(v, [["type": "setParagraph", "owner": n.id]])
            XCTAssertNil(try self.attributes(v, text)[.backgroundColor])
            XCTAssertFalse(try self.traits(self.attributes(v, text)).contains(.fixedPitchFontMask))
            let r = try await self.read(v); _ = try await self.send(v, .undo(revision: r.revision!, now: 0))
            XCTAssertTrue(try self.traits(self.attributes(v, text)).contains(.fixedPitchFontMask))
            XCTAssertTrue(v.projection.nodes.contains { $0 === n })
        }
    }
    func testNestedQuotesUseParagraphIndentAndNativeRuleMetadata() async throws {
        try await fixture { v, _ in
            XCTAssertEqual(try self.paragraph(v, "quoted").headIndent, 24)
            XCTAssertEqual(try self.paragraph(v, "nested quote").headIndent, 48)
            XCTAssertEqual(try self.attributes(v, "nested quote")[NativeStyleRegistry.quoteDepth] as? Int, 2)
            XCTAssertEqual(try self.paragraph(v, "quoted").textLists.count, 0)
        }
    }
    func testOrderedUnorderedAndNestedListDescriptors() async throws {
        try await fixture { v, _ in
            XCTAssertEqual(try self.paragraph(v, "bullet one").textLists.first?.markerFormat, .disc)
            XCTAssertTrue(try self.paragraph(v, "bullet one").textLists[0] === self.paragraph(v, "bullet two").textLists[0])
            XCTAssertEqual(try self.paragraph(v, "seven").textLists.first?.startingItemNumber, 7)
            XCTAssertEqual(try self.attributes(v, "seven")[NativeStyleRegistry.listMarker] as? String, "7.")
            XCTAssertEqual(try self.attributes(v, "eight")[NativeStyleRegistry.listMarker] as? String, "8.")
            XCTAssertEqual(try self.paragraph(v, "nested").textLists.count, 2)
            XCTAssertEqual(try self.paragraph(v, "nested").headIndent, 48)
            XCTAssertEqual(try self.paragraph(v, "seven").headIndent, 24)
        }
    }
    func testCheckedItemsAndIncrementalToggleUseSameSharedState() async throws {
        try await fixture { v, _ in
            XCTAssertEqual(try self.attributes(v, "done")[NativeStyleRegistry.listMarker] as? String, "☑")
            XCTAssertEqual(try self.attributes(v, "todo")[NativeStyleRegistry.listMarker] as? String, "☐")
            let n = try self.node(v, "todo")
            try await self.commands(v, [["type": "setChecked", "owner": n.id, "checked": true]])
            XCTAssertEqual(try self.attributes(v, "todo")[NativeStyleRegistry.listMarker] as? String, "☑")
            XCTAssertTrue(v.projection.nodes.contains { $0 === n })
            XCTAssertNil(v.projection.lastPatch)
        }
    }
    func testMarkRemovalUndoRedoKeepsIdentityAndHostAttributes() async throws {
        try await fixture { v, _ in
            let n = try self.node(v, "bold"), key = NSAttributedString.Key("host.test")
            v.textView.textStorage!.addAttribute(key, value: "keep", range: n.range)
            try await self.commands(v, [["type": "markAt", "owner": n.id, "from": 0, "to": 4, "mark": "bold", "action": "remove"]])
            XCTAssertFalse(try self.traits(self.attributes(v, "bold")).contains(.boldFontMask))
            XCTAssertEqual(try self.attributes(v, "bold")[key] as? String, "keep")
            var r = try await self.read(v); _ = try await self.send(v, .undo(revision: r.revision!, now: 0))
            XCTAssertTrue(try self.traits(self.attributes(v, "bold")).contains(.boldFontMask))
            r = try await self.read(v); _ = try await self.send(v, .redo(revision: r.revision!, now: 0))
            XCTAssertFalse(try self.traits(self.attributes(v, "bold")).contains(.boldFontMask))
            XCTAssertTrue(v.projection.nodes.contains { $0 === n })
        }
    }
    func testContainerOnlyPatchRestylesEveryUnchangedChild() async throws {
        try await fixture { v, _ in
            let one = try self.node(v, "bullet one"), two = try self.node(v, "bullet two")
            let parent = v.projection.richNodes[one.id]!.wire["parent"] as! String
            try await self.commands(v, [["type": "setStyle", "container": parent, "style": ["type": "ordered", "start": 11]]])
            XCTAssertEqual(try self.attributes(v, "bullet one")[NativeStyleRegistry.listMarker] as? String, "11.")
            XCTAssertEqual(try self.attributes(v, "bullet two")[NativeStyleRegistry.listMarker] as? String, "12.")
            XCTAssertTrue(v.projection.nodes.contains { $0 === one }); XCTAssertTrue(v.projection.nodes.contains { $0 === two })
            XCTAssertNil(v.projection.lastPatch)
        }
    }
    func testIndentOutdentUpdatesParagraphHierarchyWithoutTextMutation() async throws {
        try await fixture { v, _ in
            let n = try self.node(v, "bullet two"), text = v.textView.string
            try await self.commands(v, [["type": "indent", "owner": n.id]])
            XCTAssertEqual(try self.paragraph(v, "bullet two").textLists.count, 2)
            try await self.commands(v, [["type": "outdent", "owner": n.id]])
            XCTAssertEqual(try self.paragraph(v, "bullet two").textLists.count, 1)
            XCTAssertEqual(v.textView.string, text); XCTAssertTrue(v.projection.nodes.contains { $0 === n })
        }
    }
    func testNativeTextKitLayoutRendersCorpusAndPreservesUTF16Coordinates() async throws {
        try await fixture { v, _ in
            let layout = try XCTUnwrap(v.textView.layoutManager)
            XCTAssertTrue(layout is NativeStyledLayoutManager)
            let container = try XCTUnwrap(v.textView.textContainer)
            layout.ensureLayout(for: container)
            XCTAssertGreaterThan(layout.usedRect(for: container).height, 0)
            for n in v.projection.nodes {
                XCTAssertEqual((v.textView.string as NSString).substring(with: n.range), n.text)
            }
            let image = NSImage(size: v.frame.size)
            image.lockFocus(); NSColor.textBackgroundColor.setFill(); v.bounds.fill()
            layout.drawGlyphs(forGlyphRange: layout.glyphRange(for: container), at: .zero)
            image.unlockFocus()
            let bitmap = NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation))!
            let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            guard let output = ProcessInfo.processInfo.environment["EDITAC_MACOS_STYLE_EVIDENCE"] else { throw FixtureError() }
            try data.write(to: URL(fileURLWithPath: output).appendingPathComponent("style-corpus.png"))
            let empty = try self.node(v, "")
            v.textView.setSelectedRange(empty.range)
            _ = try await self.send(v, .resyncProjection)
            _ = try await self.read(v)
            XCTAssertEqual((v.textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.textLists.count, 1)
            let read = try await self.read(v)
            _ = try await self.send(v, .nativeEdit(revision: read.revision!, edits: [NativeSessionEdit(
                node: empty.id, fromUtf16: 0, toUtf16: 0, text: "new item")], now: 0))
            XCTAssertEqual(try self.attributes(v, "new item")[NativeStyleRegistry.listMarker] as? String, "☐")
            XCTAssertTrue(v.projection.nodes.contains { $0 === empty })
        }
    }
}
