import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureError: Error {}
@MainActor private final class Renderer: NativeAtomRenderer {
    let view: NSView = NSTextField(labelWithString: "")
    var updates = 0
    var disposals = 0
    var fails = false
    func update(_ descriptor: NativeExtensionDescriptor) throws {
        updates += 1
        if fails { throw FixtureError() }
        (view as! NSTextField).stringValue = "Native badge: " + descriptor.source
    }
    func dispose() { disposals += 1 }
}

@MainActor
final class ExtensionsTests: XCTestCase {
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { c in
            do { try view.session.submit(request) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }
    private let registry = """
    [{"type":"fixture.note","version":1,"kind":"mark","attributes":{"label":{"type":"string","required":true,"maxUtf16":32}},"content":{"type":"text","maxUtf16":32},"fallback":{"type":"text","source":"content"}}]
    """
    private func open(_ view: NativeEditorView, _ manifest: [String: Any]) async throws {
        let options = NativeSessionOptions(path: manifest["openedPath"] as! String, documentId: manifest["documentId"] as! String,
            epoch: manifest["epoch"] as! String, writable: true, permissionExpiresAt: nil)
        let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            do { try view.session.open(options: options, now: 0, registryJSON: registry) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
        XCTAssertNil(view.projectionFailure)
    }
    private func fixture(setup: @MainActor (NativeEditorView) throws -> Void = { _ in },
                         _ body: @MainActor (NativeEditorView, [String: Any]) async throws -> Void) async throws {
        _ = NSApplication.shared
        guard let path = ProcessInfo.processInfo.environment["EDITAC_MACOS_EXTENSION_FIXTURE"] else {
            XCTFail("Missing actual Rust/SQLite extension corpus"); throw FixtureError()
        }
        var manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-extensions-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = directory.appendingPathComponent("document.sqlite")
        try FileManager.default.copyItem(atPath: manifest["path"] as! String, toPath: store.path)
        manifest["openedPath"] = store.path
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 640, height: 1100))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: directory) }
        do { try setup(view); try await open(view, manifest); try await body(view, manifest) }
        catch { await withCheckedContinuation { c in view.dispose { c.resume() } }; throw error }
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }
    private func child(_ view: NativeEditorView, _ manifest: [String: Any], _ key: String) throws -> NativeExtensionView {
        try XCTUnwrap(view.extensions.views[manifest[key] as! String])
    }
    private func editNeighbor(_ view: NativeEditorView, _ manifest: [String: Any]) async throws {
        let json = String(data: try JSONSerialization.data(withJSONObject: [["type":"replaceAt", "owner":manifest["text"]!, "from":0, "to":0, "text":"Changed "]]), encoding: .utf8)!
        let snapshot = try await send(view, .read(now: 0))
        guard case let .snapshot(read) = snapshot else { throw FixtureError() }
        _ = try await send(view, .commandBatch(revision: read.revision!, json: json, origin: UUID().uuidString, now: 0))
        XCTAssertNil(view.projectionFailure)
    }
    func testActualRegisteredNativeAtom() async throws {
        let renderer = Renderer()
        try await fixture(setup: { try $0.extensions.registerAtom(type: "example.badge", version: 1) { _ in renderer } }) { view, m in
            let atom = try self.child(view, m, "custom")
            XCTAssertTrue(atom.renderer === renderer); XCTAssertTrue(renderer.view.superview === atom)
            XCTAssertTrue(atom.sourceView.isHidden); XCTAssertEqual(renderer.updates, 1)
            XCTAssertEqual(atom.descriptor.type, "example.badge")
            XCTAssertEqual((renderer.view as! NSTextField).stringValue, "Native badge: Badge 🦀")
        }
        XCTAssertEqual(renderer.disposals, 1)
    }
    func testActualUnknownTupleAndSourcePreserved() async throws {
        try await fixture { view, m in
            let atom = try self.child(view, m, "unknown")
            XCTAssertEqual(atom.descriptor.version, 42); XCTAssertEqual(atom.sourceView.string, "<script>inert</script>")
            XCTAssertNil(atom.renderer); XCTAssertFalse(atom.sourceView.isEditable)
            let tuple = try JSONSerialization.jsonObject(with: atom.descriptor.tupleJSON) as! [Any]
            XCTAssertEqual((tuple[2] as! [String: Any])["type"] as? String, "future.widget")
            let payload = try JSONSerialization.jsonObject(with: atom.descriptor.payloadJSON) as! [String: Any]
            XCTAssertEqual((payload["nested"] as! [Any])[0] as? String, "retain")
        }
    }
    func testActualInvalidMathSourceHonestCapabilities() async throws {
        try await fixture { view, m in
            let math = try self.child(view, m, "math")
            XCTAssertEqual(math.sourceView.string, "\\frac{a}{")
            XCTAssertTrue(math.diagnostic.contains("Math source only"))
            XCTAssertTrue(view.extensions.mathSourcePresentation)
            XCTAssertTrue(view.extensions.mathSourceEditing); XCTAssertFalse(view.extensions.mathTypesetting)
            XCTAssertFalse(math.sourceView.isEditable)
        }
    }
    func testActualSharedAnchorAtomSelection() async throws {
        try await fixture { view, m in
            let id = m["custom"] as! String
            try await view.extensions.select(id)
            let node = try XCTUnwrap(view.projection.nodes.first { $0.id == id })
            XCTAssertEqual(view.textView.selectedRange(), node.range)
            XCTAssertEqual(node.range.length, 1); XCTAssertTrue(view.projection.anchoredSelection)
        }
    }
    func testActualNeighborEditRetainsIdentityAndPayload() async throws {
        let renderer = Renderer()
        try await fixture(setup: { try $0.extensions.registerAtom(type: "example.badge", version: 1) { _ in renderer } }) { view, m in
            let custom = try self.child(view, m, "custom"), unknown = try self.child(view, m, "unknown")
            let wire = unknown.descriptor.tupleJSON
            try await self.editNeighbor(view, m)
            XCTAssertTrue(try self.child(view, m, "custom") === custom)
            XCTAssertTrue(try self.child(view, m, "unknown") === unknown)
            XCTAssertEqual(unknown.descriptor.tupleJSON, wire); XCTAssertGreaterThan(renderer.updates, 1)
            XCTAssertTrue(view.textView.string.hasPrefix("Changed "))
        }
    }
    func testActualDisposeIsIdempotentAndSelectionRejects() async throws {
        let renderer = Renderer()
        try await fixture(setup: { try $0.extensions.registerAtom(type: "example.badge", version: 1) { _ in renderer } }) { view, m in
            let atom = try self.child(view, m, "custom")
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            view.extensions.dispose()
            XCTAssertEqual(renderer.disposals, 1); XCTAssertNil(atom.superview); XCTAssertTrue(view.extensions.views.isEmpty)
            do { try await view.extensions.select(m["custom"] as! String); XCTFail("disposed selection") }
            catch { XCTAssertEqual(error as? NativeExtensionFailure, .disposed) }
        }
        XCTAssertEqual(renderer.disposals, 1)
    }
    func testActualRendererFailureUsesInertSource() async throws {
        let renderer = Renderer(); renderer.fails = true
        try await fixture(setup: { try $0.extensions.registerAtom(type: "example.badge", version: 1) { _ in renderer } }) { view, m in
            let atom = try self.child(view, m, "custom"), original = atom.descriptor.tupleJSON
            XCTAssertNil(atom.renderer); XCTAssertEqual(renderer.disposals, 1)
            XCTAssertEqual(atom.sourceView.string, "Badge 🦀"); XCTAssertTrue(atom.diagnostic.contains("failed"))
            try await self.editNeighbor(view, m)
            XCTAssertEqual(atom.descriptor.tupleJSON, original); XCTAssertEqual(renderer.updates, 1)
        }
        XCTAssertEqual(renderer.disposals, 1)
    }
    func testActualWrongVersionDoesNotInvokeRenderer() async throws {
        var calls = 0
        try await fixture(setup: { try $0.extensions.registerAtom(type: "future.widget", version: 1) { _ in calls += 1; return Renderer() } }) { view, m in
            XCTAssertNil(try self.child(view, m, "unknown").renderer); XCTAssertEqual(calls, 0)
        }
    }
    func testActualRegistryFreezesBeforeAttachment() async throws {
        try await fixture { view, _ in
            XCTAssertTrue(view.extensions.isFrozen)
            XCTAssertThrowsError(try view.extensions.registerAtom(type: "future.widget", version: 42) { _ in Renderer() }) { XCTAssertEqual($0 as? NativeExtensionFailure, .frozen) }
            XCTAssertThrowsError(try view.extensions.registerMark(attribute: "example.mark", present: { _ in [:] })) { XCTAssertEqual($0 as? NativeExtensionFailure, .frozen) }
        }
    }
    func testActualMarkHookDisposal() async throws {
        var disposals = 0
        try await fixture(setup: { try $0.extensions.registerMark(attribute: "example.mark", present: { _ in [.foregroundColor: NSColor.red] }, dispose: { disposals += 1 }) }) { view, _ in
            XCTAssertEqual(disposals, 0); view.extensions.dispose(); view.extensions.dispose(); XCTAssertEqual(disposals, 1)
        }
        XCTAssertEqual(disposals, 1)
    }
    func testActualLayoutReservesSeparateNativeBounds() async throws {
        try await fixture { view, m in
            for width in [640.0, 340.0] {
                view.frame.size.width = width; view.layoutSubtreeIfNeeded(); view.projection.layoutTables()
                let children = try ["custom", "unknown", "math"].map { try self.child(view, m, $0) }
                for child in children { XCTAssertGreaterThan(child.frame.width, 0); XCTAssertEqual(child.frame.height, 140) }
                XCTAssertLessThanOrEqual(children[0].frame.maxY, children[1].frame.minY)
                XCTAssertLessThanOrEqual(children[1].frame.maxY, children[2].frame.minY)
            }
        }
    }
    func testActualUnknownPayloadSurvivesDurableReopen() async throws {
        try await fixture { view, m in
            let before = try self.child(view, m, "unknown").descriptor
            try await self.editNeighbor(view, m)
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            let other = NativeEditorView(frame: view.frame)
            do {
                try await self.open(other, m)
                XCTAssertEqual(try self.child(other, m, "unknown").descriptor, before)
                XCTAssertTrue(other.textView.string.hasPrefix("Changed "))
            } catch { await withCheckedContinuation { c in other.dispose { c.resume() } }; throw error }
            await withCheckedContinuation { c in other.dispose { c.resume() } }
        }
    }
    func testActualReadOnlyPreservesPayloadAndSelection() async throws {
        try await fixture { view, m in
            let before = try self.child(view, m, "unknown").descriptor
            _ = try await self.send(view, .permission(writable: false, expiresAt: nil))
            do { try await self.editNeighbor(view, m); XCTFail("read-only mutation") } catch {}
            XCTAssertEqual(try self.child(view, m, "unknown").descriptor, before)
            try await view.extensions.select(m["unknown"] as! String)
            XCTAssertEqual(view.textView.selectedRange().length, 1)
        }
    }
    func testActualReentrantRendererDisposalCannotReattach() async throws {
        let renderer = Renderer()
        try await fixture(setup: { view in
            try view.extensions.registerAtom(type: "example.badge", version: 1) { [weak view] _ in
                view?.extensions.dispose()
                return renderer
            }
        }) { view, _ in
            XCTAssertTrue(view.extensions.views.isEmpty); XCTAssertNil(renderer.view.superview)
            XCTAssertEqual(renderer.disposals, 1)
        }
        XCTAssertEqual(renderer.disposals, 1)
    }
    private func enable(_ view: NativeEditorView) async throws {
        _ = try await send(view, .extensionPolicy(enabled: true))
    }
    private func completed(_ view: NativeEditorView, _ action: () throws -> Void) async throws {
        let done = expectation(description: "shared native command completion")
        var result: Result<Void, NativeCommandFailure>?
        view.commands.onResult = { result = $0; done.fulfill() }
        defer { view.commands.onResult = nil }
        try action()
        await fulfillment(of: [done], timeout: 5)
        try XCTUnwrap(result).get()
        XCTAssertNil(view.projectionFailure)
    }
    func testActualSourceEditOneHistoryIdentityAndUndoRedo() async throws {
        try await fixture { view, m in
            try await self.enable(view)
            let child = try self.child(view, m, "math"), before = child.descriptor
            let target = try await view.extensions.captureEdit(child.nodeID)
            XCTAssertTrue(child.sourceView.isEditable)
            try await self.completed(view) { try view.extensions.replace(target: target, source: "\\invalid{🦀") }
            XCTAssertTrue(try self.child(view, m, "math") === child)
            XCTAssertEqual(child.descriptor.source, "\\invalid{🦀")
            XCTAssertEqual(child.descriptor.payloadJSON, before.payloadJSON)
            XCTAssertEqual(view.commands.history?.undoGroups, 1)
            XCTAssertThrowsError(try view.extensions.replace(target: target, source: "reused"))
            try await self.completed(view) { view.commands.perform(.undo) }
            XCTAssertEqual(child.descriptor, before)
            try await self.completed(view) { view.commands.perform(.redo) }
            XCTAssertEqual(child.descriptor.source, "\\invalid{🦀")
        }
    }
    func testActualUnknownSourceEditingPreservesEnvelopeAndReopen() async throws {
        try await fixture { view, m in
            try await self.enable(view)
            let child = try self.child(view, m, "unknown"), before = child.descriptor
            let target = try await view.extensions.captureEdit(child.nodeID)
            try await self.completed(view) { try view.extensions.replace(target: target, source: "new <script>🦀</script>") }
            XCTAssertEqual(child.descriptor.type, before.type); XCTAssertEqual(child.descriptor.version, before.version)
            XCTAssertEqual(child.descriptor.payloadJSON, before.payloadJSON)
            let after = child.descriptor
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            let other = NativeEditorView(frame: view.frame)
            do { try await self.open(other, m); XCTAssertEqual(try self.child(other, m, "unknown").descriptor, after) }
            catch { await withCheckedContinuation { c in other.dispose { c.resume() } }; throw error }
            await withCheckedContinuation { c in other.dispose { c.resume() } }
        }
    }
    func testActualSourceCancelStaleAndBoundedInput() async throws {
        try await fixture { view, m in
            try await self.enable(view)
            let child = try self.child(view, m, "custom"), before = child.descriptor
            let cancelled = try await view.extensions.captureEdit(child.nodeID)
            child.sourceView.string = "draft"; child.cancelButton.performClick(nil)
            XCTAssertEqual(child.sourceView.string, before.source); XCTAssertFalse(child.sourceView.isEditable)
            XCTAssertThrowsError(try view.extensions.replace(target: cancelled, source: "cancelled"))
            let bounded = try await view.extensions.captureEdit(child.nodeID)
            XCTAssertThrowsError(try view.extensions.replace(target: bounded, source: String(repeating: "🦀", count: 4097)))
            let stale = try await view.extensions.captureEdit(child.nodeID)
            try await self.editNeighbor(view, m)
            XCTAssertThrowsError(try view.extensions.replace(target: stale, source: "stale"))
            XCTAssertEqual(child.descriptor, before)
        }
    }
    func testActualSourceReadOnlyPolicyAndDisposalGuards() async throws {
        try await fixture { view, m in
            let child = try self.child(view, m, "math"), before = child.descriptor
            XCTAssertFalse(child.editButton.isEnabled)
            try await self.enable(view)
            let target = try await view.extensions.captureEdit(child.nodeID)
            _ = try await self.send(view, .permission(writable: false, expiresAt: nil))
            XCTAssertThrowsError(try view.extensions.replace(target: target, source: "denied"))
            XCTAssertEqual(child.descriptor, before)
            _ = try await self.send(view, .permission(writable: true, expiresAt: nil))
            let revoked = try await view.extensions.captureEdit(child.nodeID)
            _ = try await self.send(view, .extensionPolicy(enabled: false))
            XCTAssertThrowsError(try view.extensions.replace(target: revoked, source: "revoked"))
            try await self.enable(view)
            let disposed = try await view.extensions.captureEdit(child.nodeID)
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            XCTAssertThrowsError(try view.extensions.replace(target: disposed, source: "disposed"))
        }
    }
    func testActualCustomMarkPresentationHistoryAndRemoval() async throws {
        try await fixture(setup: { try $0.extensions.registerMark(attribute: "module:fixture.note", present: { _ in [.backgroundColor: NSColor.yellow] }) }) { view, m in
            try await self.enable(view)
            let node = try XCTUnwrap(view.projection.nodes.first { $0.id == m["text"] as? String })
            @MainActor func target() throws -> NativeTextSelectionTarget { try view.projection.capture(range: NSRange(location: node.range.location, length: 6), backwards: false, affinity: .downstream) }
            let value = Data("[1,{\"label\":\"native\"}]".utf8)
            try await self.completed(view) { try view.extensions.applyMark(attribute: "module:fixture.note", valueJSON: value, target: target()) }
            XCTAssertEqual(view.textView.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil) as? NSColor, .yellow)
            XCTAssertEqual(view.commands.history?.undoGroups, 1)
            try await self.completed(view) { view.commands.perform(.undo) }
            XCTAssertNotEqual(view.textView.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil) as? NSColor, .yellow)
            try await self.completed(view) { view.commands.perform(.redo) }
            XCTAssertEqual(view.textView.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil) as? NSColor, .yellow)
            try await self.completed(view) { try view.extensions.applyMark(attribute: "module:fixture.note", valueJSON: nil, target: target()) }
            XCTAssertNotEqual(view.textView.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil) as? NSColor, .yellow)
        }
    }
    func testActualCustomMarkStaleTargetAndReadOnly() async throws {
        try await fixture(setup: { try $0.extensions.registerMark(attribute: "module:fixture.note", present: { _ in [:] }) }) { view, m in
            try await self.enable(view)
            let target = try view.projection.capture(range: NSRange(location: 0, length: 6), backwards: false, affinity: .downstream)
            try await self.editNeighbor(view, m)
            XCTAssertThrowsError(try view.extensions.applyMark(attribute: "module:fixture.note", valueJSON: nil, target: target))
            _ = try await self.send(view, .permission(writable: false, expiresAt: nil))
            let current = try view.projection.capture(range: NSRange(location: 0, length: 6), backwards: false, affinity: .downstream)
            let done = self.expectation(description: "read-only mark rejected")
            view.commands.onResult = { if case .success = $0 { XCTFail("read-only mutation") }; done.fulfill() }
            try view.extensions.applyMark(attribute: "module:fixture.note", valueJSON: Data("[1,{\"label\":\"denied\"}]".utf8), target: current)
            await self.fulfillment(of: [done], timeout: 5)
            XCTAssertEqual(view.commands.history?.undoGroups, 1)
        }
    }
    func testActualNativeMarkButtonDispatchAndRevocation() async throws {
        try await fixture(setup: { try $0.extensions.registerMark(attribute: "module:fixture.note", present: { _ in [.backgroundColor: NSColor.yellow] }) }) { view, _ in
            let button = view.extensions.makeMarkButton(attribute: "module:fixture.note", valueJSON: Data("[1,{\"label\":\"button\"}]".utf8), title: "Highlight note")
            XCTAssertFalse(button.isEnabled)
            try await self.enable(view)
            try await view.select(range: NSRange(location: 0, length: 6), backwards: false, affinity: .downstream)
            XCTAssertTrue(button.isEnabled)
            try await self.completed(view) { button.performClick(nil) }
            XCTAssertEqual(view.textView.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil) as? NSColor, .yellow)
            _ = try await self.send(view, .extensionPolicy(enabled: false))
            XCTAssertFalse(button.isEnabled)
            view.extensions.dispose(); XCTAssertFalse(button.isEnabled)
        }
    }
    func testActualNativeSourceSaveUpdatesRegisteredRenderer() async throws {
        let renderer = Renderer()
        try await fixture(setup: { try $0.extensions.registerAtom(type: "example.badge", version: 1) { _ in renderer } }) { view, m in
            try await self.enable(view)
            let child = try self.child(view, m, "custom")
            child.editButton.performClick(nil)
            for _ in 0..<100 where !child.sourceView.isEditable { try await Task.sleep(nanoseconds: 10_000_000) }
            XCTAssertTrue(child.sourceView.isEditable)
            XCTAssertFalse(child.sourceView.isHidden)
            child.sourceView.string = "Edited badge 🦀"
            try await self.completed(view) { child.saveButton.performClick(nil) }
            XCTAssertEqual(child.descriptor.source, "Edited badge 🦀")
            XCTAssertEqual((renderer.view as! NSTextField).stringValue, "Native badge: Edited badge 🦀")
            XCTAssertFalse(child.sourceView.isEditable); XCTAssertFalse(renderer.view.isHidden)
        }
        XCTAssertEqual(renderer.disposals, 1)
    }
    // Prepared presentation guards do not qualify shared custom-mark editing.
    func testPreparedMarkPresentationCannotOverwriteSharedWire() throws {
        let view = NativeEditorView(frame: .zero)
        defer { view.dispose() }
        try view.extensions.registerMark(attribute: "example.mark", present: { data in
            XCTAssertEqual(String(data: data, encoding: .utf8), "{\"level\":2}")
            return [.foregroundColor: NSColor.red, NativeTextProjection.sharedRunAttributes: "bad", .attachment: NSTextAttachment()]
        })
        let attributes: [String: Any] = ["example.mark": ["level": 2]]
        let storage = NSTextStorage(string: "🦀ab", attributes: [NativeTextProjection.sharedRunAttributes: attributes])
        view.extensions.presentMarks(in: storage)
        XCTAssertEqual(storage.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, .red)
        XCTAssertNil(storage.attribute(.attachment, at: 0, effectiveRange: nil))
        XCTAssertTrue(NSDictionary(dictionary: storage.attribute(NativeTextProjection.sharedRunAttributes, at: 0, effectiveRange: nil) as! [String: Any]).isEqual(to: attributes))
    }
    func testPreparedMarkFailureRetainsSource() throws {
        let view = NativeEditorView(frame: .zero); defer { view.dispose() }
        try view.extensions.registerMark(attribute: "example.mark", present: { _ in throw FixtureError() })
        let storage = NSTextStorage(string: "ab", attributes: [NativeTextProjection.sharedRunAttributes: ["example.mark": true]])
        view.extensions.presentMarks(in: storage)
        XCTAssertEqual(storage.string, "ab"); XCTAssertNil(storage.attribute(.foregroundColor, at: 0, effectiveRange: nil))
    }
    func testPreparedDuplicateRegistrationDoesNotReplaceOriginal() throws {
        let view = NativeEditorView(frame: .zero); defer { view.dispose() }
        var disposals = 0
        try view.extensions.registerMark(attribute: "example.mark", present: { _ in [:] }, dispose: { disposals += 1 })
        XCTAssertThrowsError(try view.extensions.registerMark(attribute: "example.mark", present: { _ in [:] })) { XCTAssertEqual($0 as? NativeExtensionFailure, .duplicate) }
        try view.extensions.registerAtom(type: "example.badge", version: 1) { _ in Renderer() }
        XCTAssertThrowsError(try view.extensions.registerAtom(type: "example.badge", version: 1) { _ in Renderer() }) { XCTAssertEqual($0 as? NativeExtensionFailure, .duplicate) }
        view.extensions.dispose(); XCTAssertEqual(disposals, 1)
    }
    func testPreparedMalformedDescriptorRejected() throws {
        for version: Any in [true, 0, -1, 1.5, 4_294_967_296.0] {
            XCTAssertThrowsError(try NativeExtensionDescriptor(["module:future.widget", version, ["source":"retained"]]))
        }
        XCTAssertThrowsError(try NativeExtensionDescriptor(["module:editac.inert-extension", 1, ["type":"future.widget"]]))
    }
}
