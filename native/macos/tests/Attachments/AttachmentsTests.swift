import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureError: Error {}
@MainActor private final class CommandWait {
    var continuation: CheckedContinuation<Void, Error>?
    func resolve(_ result: Result<Void, Error>) {
        guard let c = continuation else { return }; continuation = nil; c.resume(with: result)
    }
}

@MainActor
final class AttachmentsTests: XCTestCase {
    private static var launched = false
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
        _ = NSApplication.shared
        if !Self.launched { NSApp.setActivationPolicy(.regular); NSApp.finishLaunching(); Self.launched = true }
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
    private func enable(_ view: NativeEditorView) async throws {
        view.commands.now = { 0 }
        _ = try await send(view, .atomicContentPolicy(images: true, references: true))
        NSApp.activate(ignoringOtherApps: true)
        guard let window = view.window else { throw FixtureError() }
        window.makeKeyAndOrderFront(nil)
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: false) { _ in MainActor.assumeIsolated {
            window.makeKey(); NSApp.stop(nil)
            NSApp.postEvent(NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [],
                timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0)!, atStart: true)
        } }
        NSApp.run(); window.makeKey(); window.makeFirstResponder(view.textView)
        view.commands.refreshControls()
        XCTAssertTrue(window.isKeyWindow)
    }
    private func perform(_ view: NativeEditorView, _ action: () throws -> Void) async throws {
        let wait = CommandWait()
        let deadline = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            wait.resolve(.failure(FixtureError()))
        }
        defer { deadline.cancel(); view.commands.onResult = nil }
        try await withCheckedThrowingContinuation { c in
            wait.continuation = c
            view.commands.onResult = { wait.resolve($0.mapError { $0 as Error }) }
            do { try action() } catch { wait.resolve(.failure(error)) }
        }
        XCTAssertNil(view.projectionFailure)
    }
    private func replacement(_ kind: NativeAttachmentDescriptor.Kind) throws -> NativeAttachmentDescriptor {
        kind == .image ? try .image(url: "https://example.test/replaced.png", alt: "New alt 🦀", title: "New title", source: "![New alt 🦀](https://example.test/replaced.png)")
            : try .reference(targetID: "ac://fixture/replaced", label: "New reference אב")
    }
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
                _ = try await self.read(view)
                XCTAssertEqual(view.projection.selectionResolutions.count, 2)
                if case let .position(_, offset, _, _, _) = view.projection.selectionResolutions.last?.resolution {
                    let expected = key == "reference" ? (try self.atom(view, manifest, key)).descriptor.label.utf16.count : 0
                    XCTAssertEqual(Int(offset), expected)
                } else { XCTFail("Missing shared endpoint resolution") }
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
    func testReentrantHostCancellationKeepsNewestRequestAndCancelsExactlyOnce() async throws {
        try await fixture { view, manifest in
            let child = try self.atom(view, manifest)
            var callbacks: [@MainActor (Result<NSImage, Error>) -> Void] = []
            var cancellations = 0
            view.attachments.imageResolver = { _, complete in callbacks.append(complete) }
            view.attachments.cancelHostRequest = { _ in
                cancellations += 1
                if cancellations == 1 { view.attachments.resolve(child.nodeID) }
            }
            view.attachments.resolve(child.nodeID)
            view.attachments.resolve(child.nodeID)
            XCTAssertEqual(callbacks.count, 2); XCTAssertEqual(cancellations, 1)
            let latest = self.image(); callbacks[1](.success(latest)); callbacks[0](.success(self.image()))
            XCTAssertTrue(child.imageView.image === latest)
        }
    }

    func testImageReplacementUsesSharedHistoryAndKeepsNativeIdentity() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let child = try self.atom(view, manifest), reference = try self.atom(view, manifest, "reference")
            let before = try await self.read(view), descriptor = child.descriptor
            let target = try await view.attachments.captureEdit(child.nodeID)
            let replacement = try self.replacement(.image)
            try await self.perform(view) { try view.attachments.replace(target: target, with: replacement) }
            XCTAssertTrue(view.attachments.views[child.nodeID] === child)
            XCTAssertTrue(view.attachments.views[reference.nodeID] === reference)
            XCTAssertEqual(child.descriptor, replacement); XCTAssertEqual(child.label.stringValue, replacement.label)
            XCTAssertEqual(child.state, .unresolved); XCTAssertNil(child.imageView.image)
            let changed = try await self.read(view)
            XCTAssertEqual(changed.nodes.map(\.id), before.nodes.map(\.id)); XCTAssertNotEqual(changed.revision, before.revision)
            XCTAssertThrowsError(try view.attachments.replace(target: target, with: replacement))
            try await self.perform(view) { view.commands.perform(.undo) }
            XCTAssertEqual(child.descriptor, descriptor)
            try await self.perform(view) { view.commands.perform(.redo) }
            XCTAssertEqual(child.descriptor, replacement)
        }
    }
    func testReferenceReplacementAndWholeAtomRemovalRestoreDescriptorAndFallback() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let child = try self.atom(view, manifest, "reference"), id = child.nodeID
            let original = child.descriptor, before = try await self.read(view)
            let target = try await view.attachments.captureEdit(id), replacement = try self.replacement(.reference)
            try await self.perform(view) { try view.attachments.replace(target: target, with: replacement) }
            XCTAssertTrue(view.attachments.views[id] === child)
            XCTAssertEqual(child.descriptor.target, replacement.target); XCTAssertEqual(child.label.stringValue, replacement.label)
            let removal = try await view.attachments.captureEdit(id)
            try await self.perform(view) { try view.attachments.remove(target: removal) }
            XCTAssertNil(view.attachments.views[id]); XCTAssertNil(child.superview)
            let removed = try await self.read(view)
            XCTAssertEqual(removed.nodes.map(\.id), before.nodes.map(\.id))
            XCTAssertEqual(removed.nodes.first(where: { $0.id == id })?.text, "")
            try await self.perform(view) { view.commands.perform(.undo) }
            XCTAssertEqual(try self.atom(view, manifest, "reference").descriptor, replacement)
            try await self.perform(view) { view.commands.perform(.undo) }
            XCTAssertEqual(try self.atom(view, manifest, "reference").descriptor, original)
            let observed1 = try await self.read(view)
            XCTAssertEqual(observed1.nodes.first(where: { $0.id == id })?.text, before.nodes.first(where: { $0.id == id })?.text)
        }
    }
    func testNativeReplaceAndRemoveButtonsUseHostResultExactlyOnce() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let child = try self.atom(view, manifest), replacement = try self.replacement(.image)
            var calls = 0
            var duplicate: (@MainActor (Result<NativeAttachmentDescriptor?, Error>) -> Void)?
            view.attachments.replacementProvider = { target, complete in
                calls += 1; XCTAssertEqual(target.nodeID, child.nodeID)
                duplicate = complete; complete(.success(replacement))
            }
            XCTAssertTrue(child.replaceButton.isEnabled); XCTAssertTrue(child.removeButton.isEnabled)
            try await self.perform(view) { child.replaceButton.performClick(nil) }
            XCTAssertEqual(calls, 1); XCTAssertEqual(child.descriptor, replacement)
            let before = try await self.read(view)
            duplicate?(.success(try self.replacement(.image)))
            let observed2 = try await self.read(view)
            XCTAssertEqual(observed2.revision, before.revision)
            try await self.perform(view) { child.removeButton.performClick(nil) }
            XCTAssertNil(view.attachments.views[child.nodeID])
            try await self.perform(view) { view.commands.perform(.undo) }
            XCTAssertEqual(try self.atom(view, manifest).descriptor, replacement)
        }
    }
    func testCancelledAndStaleEditTargetsCannotMutateEitherFamily() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            for key in ["image", "reference"] {
                let child = try self.atom(view, manifest, key), before = try await self.read(view)
                let cancelled = try await view.attachments.captureEdit(child.nodeID)
                view.attachments.cancel(child.nodeID)
                XCTAssertThrowsError(try view.attachments.replace(target: cancelled, with: self.replacement(child.descriptor.kind)))
                let observed3 = try await self.read(view)
                XCTAssertEqual(observed3.revision, before.revision)
                let stale = try await view.attachments.captureEdit(child.nodeID)
                try await self.commands(view, [["type":"replaceAt","owner":before.nodes[0].id,"from":0,"to":0,"text":"remote-like "]])
                let changed = try await self.read(view)
                XCTAssertThrowsError(try view.attachments.remove(target: stale))
                let observed4 = try await self.read(view)
                XCTAssertEqual(observed4.revision, changed.revision)
            }
        }
    }
    func testPermissionAndPolicyRevocationRejectCapturedEdits() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let child = try self.atom(view, manifest), before = try await self.read(view)
            let denied = try await view.attachments.captureEdit(child.nodeID)
            _ = try await self.send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            XCTAssertThrowsError(try view.attachments.replace(target: denied, with: self.replacement(.image)))
            XCTAssertFalse(child.removeButton.isEnabled)
            _ = try await self.send(view, .commandPermission(writable: true, expiresAt: nil, now: 0))
            let revoked = try await view.attachments.captureEdit(child.nodeID)
            _ = try await self.send(view, .atomicContentPolicy(images: false, references: true))
            XCTAssertThrowsError(try view.attachments.remove(target: revoked))
            XCTAssertFalse(child.removeButton.isEnabled)
            let observed5 = try await self.read(view)
            XCTAssertEqual(observed5.revision, before.revision)
        }
    }
    func testForeignSessionAndDisposedTargetsCannotRetarget() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let child = try self.atom(view, manifest), target = try await view.attachments.captureEdit(child.nodeID)
            try await self.fixture { other, _ in
                try await self.enable(other)
                let before = try await self.read(other)
                XCTAssertThrowsError(try other.attachments.remove(target: target))
                let observed6 = try await self.read(other)
                XCTAssertEqual(observed6.revision, before.revision)
            }
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            XCTAssertThrowsError(try view.attachments.replace(target: target, with: self.replacement(.image)))
        }
    }
    func testHostReplacementCancellationAndFailureLeaveDocumentUntouched() async throws {
        try await fixture { view, manifest in
            try await self.enable(view)
            let child = try self.atom(view, manifest), before = try await self.read(view)
            for fails in [false, true] {
                let called = expectation(description: "host replacement callback")
                view.attachments.replacementProvider = { _, complete in
                    if fails { complete(.failure(FixtureError())) } else { complete(.success(nil)) }
                    called.fulfill()
                }
                child.replaceButton.performClick(nil)
                await fulfillment(of: [called], timeout: 5)
                _ = try await self.read(view)
                XCTAssertEqual(child.state, fails ? .failed("FixtureError()") : .cancelled)
            }
            let observed7 = try await self.read(view)
            XCTAssertEqual(observed7.revision, before.revision)
        }
    }
    func testSameFamilyValidationAndDefaultOffControlsFailClosed() async throws {
        try await fixture { view, manifest in
            let child = try self.atom(view, manifest)
            XCTAssertFalse(child.removeButton.isEnabled)
            try await self.enable(view)
            XCTAssertTrue(child.removeButton.isEnabled); XCTAssertFalse(child.replaceButton.isEnabled)
            let target = try await view.attachments.captureEdit(child.nodeID), before = try await self.read(view)
            XCTAssertThrowsError(try view.attachments.replace(target: target, with: self.replacement(.reference)))
            let observed8 = try await self.read(view)
            XCTAssertEqual(observed8.revision, before.revision)
            XCTAssertThrowsError(try NativeAttachmentDescriptor.image(url: "javascript:bad", alt: "unsafe"))
            XCTAssertThrowsError(try NativeAttachmentDescriptor.reference(targetID: "bad\n", label: "unsafe"))
        }
    }

}
