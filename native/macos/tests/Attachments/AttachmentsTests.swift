import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureError: Error {}

@MainActor
final class AttachmentsTests: XCTestCase {
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
        guard let path = ProcessInfo.processInfo.environment["EDITAC_MACOS_ATTACHMENT_FIXTURE"] else {
            XCTFail("Missing actual Rust/SQLite attachment fixture; no DTO or skip substitute"); throw FixtureError()
        }
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-attachments-" + UUID().uuidString)
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
    private func atom(_ view: NativeEditorView, _ manifest: [String: Any], _ key: String = "image") throws -> NativeAttachmentView {
        try XCTUnwrap(view.attachments.views[manifest[key] as! String])
    }
    private func image() -> NSImage { NSImage(size: NSSize(width: 32, height: 24), flipped: false) { rect in
        NSColor.systemBlue.setFill(); rect.fill(); return true
    } }
    func testNativeViewsRetainImageMetadataAndReferenceIdentityWithoutLoading() async throws {
        try await fixture { view, manifest in
            let image = try self.atom(view, manifest), reference = try self.atom(view, manifest, "reference")
            XCTAssertEqual(image.descriptor.label, "A crab 🦀"); XCTAssertEqual(image.descriptor.title, "Fixture image")
            XCTAssertFalse(image.descriptor.source.isEmpty); XCTAssertEqual(image.state, .unresolved)
            XCTAssertEqual(reference.descriptor.target, "ac://fixture/document"); XCTAssertEqual(reference.label.stringValue, "Reference אב")
            XCTAssertTrue(image.superview === view.textView); XCTAssertTrue(reference.superview === view.textView)
            XCTAssertFalse(image.replaceButton.isEnabled); XCTAssertFalse(reference.removeButton.isEnabled)
            var calls = 0
            view.attachments.imageResolver = { _, _ in calls += 1 }
            view.attachments.referenceResolver = { _, _ in calls += 1 }
            _ = try await self.read(view)
            XCTAssertEqual(calls, 0)
        }
    }
    func testExplicitImageActionPresentsHostDecodedImageAndWritesNativeArtifact() async throws {
        try await fixture { view, manifest in
            let child = try self.atom(view, manifest); let pixels = self.image()
            view.attachments.imageResolver = { request, complete in
                XCTAssertEqual(request.descriptor.target, child.descriptor.target); complete(.success(pixels))
            }
            child.activateButton.performClick(nil)
            XCTAssertEqual(child.state, .ready); XCTAssertTrue(child.imageView.image === pixels)
            view.textView.layoutSubtreeIfNeeded(); child.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            let directory = try XCTUnwrap(ProcessInfo.processInfo.environment["EDITAC_MACOS_ATTACHMENT_EVIDENCE"])
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("native-attachments.png"))
        }
    }
    func testHostFailureAndMissingPortsExposeErrorStateWithoutMutation() async throws {
        try await fixture { view, manifest in
            let child = try self.atom(view, manifest); let before = try await self.read(view)
            view.attachments.resolve(child.nodeID)
            XCTAssertEqual(child.state, .failed("Host resolver unavailable"))
            view.attachments.imageResolver = { _, complete in complete(.failure(FixtureError())) }
            view.attachments.resolve(child.nodeID)
            if case .failed = child.state {} else { XCTFail("Expected explicit failure") }
            let after = try await self.read(view); XCTAssertEqual(before.revision, after.revision)
        }
    }
    func testReferenceActivationPreservesStoredLabelAndRequiresExplicitHostResult() async throws {
        try await fixture { view, manifest in
            let child = try self.atom(view, manifest, "reference")
            var callback: (@MainActor (Result<String, Error>) -> Void)?; var activations = 0
            view.attachments.referenceResolver = { request, complete in
                XCTAssertEqual(request.descriptor.target, "ac://fixture/document"); callback = complete
            }
            view.attachments.onReferenceActivated = { request, destination in
                XCTAssertEqual(request.descriptor.label, "Reference אב"); XCTAssertEqual(destination, "local-approved-target"); activations += 1
            }
            child.activateButton.performClick(nil); XCTAssertEqual(activations, 0)
            try XCTUnwrap(callback)(.success("local-approved-target"))
            XCTAssertEqual(child.state, .ready); XCTAssertEqual(activations, 1)
            XCTAssertEqual(child.label.stringValue, "Reference אב")
            callback?(.success("duplicate")); XCTAssertEqual(activations, 1)
        }
    }
    func testCancelledImageAndReferenceCompletionsCannotDeliver() async throws {
        try await fixture { view, manifest in
            var imageCompletion: (@MainActor (Result<NSImage, Error>) -> Void)?
            var referenceCompletion: (@MainActor (Result<String, Error>) -> Void)?
            var cancellations = 0, activations = 0
            view.attachments.cancelHostRequest = { _ in cancellations += 1 }
            view.attachments.imageResolver = { _, complete in imageCompletion = complete }
            view.attachments.referenceResolver = { _, complete in referenceCompletion = complete }
            view.attachments.onReferenceActivated = { _, _ in activations += 1 }
            for key in ["image", "reference"] {
                let child = try self.atom(view, manifest, key)
                view.attachments.resolve(child.nodeID); child.cancelButton.performClick(nil)
                XCTAssertEqual(child.state, .cancelled)
            }
            imageCompletion?(.success(self.image())); referenceCompletion?(.success("late"))
            XCTAssertNil(try self.atom(view, manifest).imageView.image)
            XCTAssertEqual(cancellations, 2); XCTAssertEqual(activations, 0)
        }
    }
    func testRevisionChangeRejectsBothLateResolutionsAndRetainsViews() async throws {
        try await fixture { view, manifest in
            let image = try self.atom(view, manifest), reference = try self.atom(view, manifest, "reference")
            var a: (@MainActor (Result<NSImage, Error>) -> Void)?; var b: (@MainActor (Result<String, Error>) -> Void)?
            var activations = 0
            view.attachments.imageResolver = { _, c in a = c }; view.attachments.referenceResolver = { _, c in b = c }
            view.attachments.onReferenceActivated = { _, _ in activations += 1 }
            view.attachments.resolve(image.nodeID); view.attachments.resolve(reference.nodeID)
            let before = try await self.read(view)
            try await self.commands(view, [["type":"replaceAt", "owner":before.nodes[0].id, "from":0,"to":0,"text":"Remote-shaped revision 🦀"]])
            XCTAssertTrue(try self.atom(view, manifest) === image); XCTAssertTrue(try self.atom(view, manifest, "reference") === reference)
            a?(.success(self.image())); b?(.success("late"))
            XCTAssertNil(image.imageView.image); XCTAssertEqual(activations, 0)
            XCTAssertEqual(image.state, .cancelled); XCTAssertEqual(reference.state, .cancelled)
        }
    }
    func testSupersededOutOfOrderImageAndReferenceResultsAreIgnored() async throws {
        try await fixture { view, manifest in
            let image = try self.atom(view, manifest), reference = try self.atom(view, manifest, "reference")
            var images: [@MainActor (Result<NSImage, Error>) -> Void] = []
            var references: [@MainActor (Result<String, Error>) -> Void] = []; var values: [String] = []
            view.attachments.imageResolver = { _, c in images.append(c) }; view.attachments.referenceResolver = { _, c in references.append(c) }
            view.attachments.onReferenceActivated = { _, value in values.append(value) }
            for _ in 0..<2 { view.attachments.resolve(image.nodeID); view.attachments.resolve(reference.nodeID) }
            let latest = self.image(); images[1](.success(latest)); references[1](.success("new"))
            images[0](.success(self.image())); references[0](.success("old"))
            XCTAssertTrue(image.imageView.image === latest); XCTAssertEqual(values, ["new"])
        }
    }
    func testDisposalCancelsHostRequestsAndRejectsCompletions() async throws {
        try await fixture { view, manifest in
            let child = try self.atom(view, manifest)
            var a: (@MainActor (Result<NSImage, Error>) -> Void)?; var b: (@MainActor (Result<String, Error>) -> Void)?
            var activated = false, cancelled = 0
            view.attachments.imageResolver = { _, c in a = c }; view.attachments.referenceResolver = { _, c in b = c }
            view.attachments.onReferenceActivated = { _, _ in activated = true }
            view.attachments.cancelHostRequest = { _ in cancelled += 1 }
            view.attachments.resolve(child.nodeID); view.attachments.resolve(manifest["reference"] as! String)
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            a?(.success(self.image())); b?(.success("late"))
            XCTAssertFalse(activated); XCTAssertNil(child.imageView.image); XCTAssertNil(child.superview)
            XCTAssertTrue(view.attachments.views.isEmpty); XCTAssertEqual(cancelled, 2)
        }
    }
    func testBothNativeAtomSelectionsUseSharedAnchors() async throws {
        try await fixture { view, manifest in
            for key in ["image", "reference"] {
                let id = manifest[key] as! String
                try await view.attachments.select(id)
                XCTAssertEqual(view.textView.selectedRange().length, 1)
                XCTAssertEqual(view.projection.selection?.anchor.node, id)
                XCTAssertTrue(view.projection.anchoredSelection)
                XCTAssertEqual(view.projection.selectionResolutions.count, 2)
            }
        }
    }
    func testReadOnlyPreservesNavigationAndRejectsUnavailableMutation() async throws {
        try await fixture { view, manifest in
            _ = try await self.send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            let before = try await self.read(view), id = manifest["image"] as! String
            try await view.attachments.select(id)
            XCTAssertThrowsError(try view.attachments.replace(id)); XCTAssertThrowsError(try view.attachments.remove(id))
            XCTAssertFalse(try self.atom(view, manifest).replaceButton.isEnabled)
            let after = try await self.read(view); XCTAssertEqual(before.revision, after.revision)
        }
    }
    func testNativeAttachmentLayoutDoesNotOverlapAndTracksPrecedingEdits() async throws {
        try await fixture { view, manifest in
            let image = try self.atom(view, manifest), reference = try self.atom(view, manifest, "reference")
            view.projection.layoutTables()
            XCTAssertFalse(image.frame.intersects(reference.frame)); XCTAssertGreaterThan(image.frame.height, 100)
            let y = image.frame.minY, before = try await self.read(view)
            try await self.commands(view, [["type":"replaceAt","owner":before.nodes[0].id,"from":0,"to":0,"text":"Line\nLine\n"]])
            view.projection.layoutTables()
            XCTAssertGreaterThan(image.frame.minY, y); XCTAssertFalse(image.frame.intersects(reference.frame))
            XCTAssertEqual(image.frame.width, reference.frame.width)
        }
    }
    func testHostPortReplacementCancelsOutstandingResolution() async throws {
        try await fixture { view, manifest in
            let child = try self.atom(view, manifest)
            var callback: (@MainActor (Result<NSImage, Error>) -> Void)?
            view.attachments.imageResolver = { _, c in callback = c }; view.attachments.resolve(child.nodeID)
            view.attachments.imageResolver = nil
            callback?(.success(self.image())); XCTAssertNil(child.imageView.image); XCTAssertEqual(child.state, .cancelled)
        }
    }
    func testMalformedDescriptorsRejectBeforeNativeProjectionChanges() async throws {
        try await fixture { view, _ in
            let before = view.textView.string
            for tuple: [Any] in [
                ["module:editac.image",1,["url":"file:///etc/passwd","alt":"x","title":"","source":""]],
                ["module:editac.reference",1,["targetId":"x","label":"bad\nlabel"]],
                ["module:editac.image",99,[:]]
            ] { XCTAssertThrowsError(try NativeAttachmentDescriptor(tuple)) }
            XCTAssertEqual(view.textView.string, before)
        }
    }
    func testSharedCatalogTruthfullyDeclinesImageAndReferenceMutationProfiles() async throws {
        try await fixture { view, manifest in
            let before = try await self.read(view)
            for profile in ["editac.images", "editac.references"] {
                XCTAssertEqual(view.commands.profileAvailability(profile)?.available, false)
                do { try await view.commands.check(commandsJSON: "[{\"type\":\"replaceAt\",\"owner\":\"invalid\",\"from\":0,\"to\":0,\"text\":\"x\"}]", profile: profile); XCTFail("Unavailable host policy admitted") }
                catch {}
            }
            for key in ["image", "reference"] {
                let child = try self.atom(view, manifest, key)
                XCTAssertThrowsError(try view.attachments.remove(child.nodeID)); XCTAssertThrowsError(try view.attachments.replace(child.nodeID))
            }
            let after = try await self.read(view); XCTAssertEqual(before.revision, after.revision)
        }
    }
}
