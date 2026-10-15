import AppKit
import XCTest
@testable import EditacMacOS

private struct UnexpectedResponse: Error {}

@MainActor
final class EditsTests: XCTestCase {
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
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-edits-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: directory) }
        let options = NativeSessionOptions(path: directory.appendingPathComponent("document.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil)
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
            view.input.now = { 0 }
            try await body(view, snapshot)
        } catch {
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            throw error
        }
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }

    private func nativeEdit(_ view: NativeEditorView, range: NSRange, text: String) async throws {
        let result: Result<Void, NativeInputFailure> = await withCheckedContinuation { continuation in
            view.input.onResult = { result in
                view.input.onResult = nil
                continuation.resume(returning: result)
            }
            view.textView.insertText(text, replacementRange: range)
        }
        try result.get()
    }

    private func assertSingleCommit(_ view: NativeEditorView, _ before: NativeSessionRead,
                                    text: String) async throws {
        let after = try await read(view)
        XCTAssertEqual(after.nodes[0].text, text)
        XCTAssertEqual(view.textView.string, after.nodes.map(\.text).joined(separator: "\n"))
        XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
        XCTAssertNotEqual(after.revision, before.revision)
        XCTAssertEqual(view.input.acceptedCount, 1)
        XCTAssertFalse(view.input.isPending)
        XCTAssertFalse(view.textView.allowsUndo)
    }

    func testNativeInsertCommitsExactlyOnceAndUndoUsesSharedHistory() async throws {
        try await fixture(["AB"]) { view, before in
            try await self.nativeEdit(view, range: NSRange(location: 1, length: 0), text: "🦀")
            try await self.assertSingleCommit(view, before, text: "A🦀B")
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 3, length: 0))
            let after = try await self.read(view)
            _ = try await self.send(view, .undo(revision: after.revision!, now: 0))
            let undone = try await self.read(view)
            XCTAssertEqual(undone.nodes[0].text, "AB")
        }
    }

    func testNativeDeleteUsesAppKitGraphemeRangeAndCommitsOnce() async throws {
        try await fixture(["A🦀B"]) { view, before in
            view.textView.setSelectedRange(NSRange(location: 3, length: 0))
            let result: Result<Void, NativeInputFailure> = await withCheckedContinuation { c in
                view.input.onResult = { result in view.input.onResult = nil; c.resume(returning: result) }
                view.textView.deleteBackward(nil)
            }
            try result.get()
            try await self.assertSingleCommit(view, before, text: "AB")
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 1, length: 0))
        }
    }

    func testNativeReplacementPreservesUnicodeAndNodeIdentity() async throws {
        try await fixture(["A🦀e\u{301}B"]) { view, before in
            let identity = view.projection.nodes[0]
            try await self.nativeEdit(view, range: NSRange(location: 1, length: 4), text: "אב")
            try await self.assertSingleCommit(view, before, text: "AאבB")
            XCTAssertTrue(view.projection.nodes[0] === identity)
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 3, length: 0))
        }
    }

    func testNativeEditMapsSecondBidiParagraphWithoutChangingFirst() async throws {
        try await fixture(["🦀", "אבג"]) { view, before in
            try await self.nativeEdit(view, range: NSRange(location: 4, length: 1), text: "ز")
            let after = try await self.read(view)
            XCTAssertEqual(after.nodes.map(\.text), ["🦀", "אزג"])
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
            XCTAssertEqual(view.textView.string, "🦀\nאزג")
        }
    }

    func testPermissionRejectionKeepsTextSelectionAndDurableRevision() async throws {
        try await fixture(["AB"]) { view, before in
            _ = try await self.send(view, .permission(writable: false, expiresAt: nil))
            view.textView.setSelectedRange(NSRange(location: 1, length: 0))
            do { try await self.nativeEdit(view, range: NSRange(location: 1, length: 0), text: "bad"); XCTFail("accepted") }
            catch {}
            let after = try await self.read(view)
            XCTAssertEqual(after.revision, before.revision)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertEqual(view.textView.string, "AB")
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 1, length: 0))
            XCTAssertEqual(view.input.acceptedCount, 0)
            XCTAssertFalse(view.textView.isEditable)
        }
    }

    func testStaleNativeTargetRejectsAndResynchronizesActualSession() async throws {
        try await fixture(["AB"]) { view, before in
            guard case let .prepared(token) = try await self.send(view, .prepare(revision: before.revision!,
                edits: [NativeSessionEdit(node: before.nodes[0].id, fromUtf16: 0, toUtf16: 1, text: "Z")],
                origin: "external-fixture", now: 0)) else { throw UnexpectedResponse() }
            // Commit without a read leaves the native revision deliberately stale.
            _ = try await self.send(view, .commit(token: token, now: 0))
            do { try await self.nativeEdit(view, range: NSRange(location: 1, length: 0), text: "bad"); XCTFail("accepted stale edit") }
            catch {}
            XCTAssertEqual(view.textView.string, "ZB")
            let after = try await self.read(view)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
            XCTAssertEqual(view.input.acceptedCount, 0)
        }
    }

    func testPendingNativeEditCannotBeSubmittedTwice() async throws {
        try await fixture(["AB"]) { view, before in
            let completed = expectation(description: "first commit")
            view.input.onResult = { result in
                if case .success = result { completed.fulfill() }
            }
            view.textView.insertText("X", replacementRange: NSRange(location: 1, length: 0))
            XCTAssertTrue(view.input.isPending)
            XCTAssertFalse(view.textView.shouldChangeText(in: NSRange(location: 1, length: 0), replacementString: "Y"))
            await fulfillment(of: [completed], timeout: 5)
            view.input.onResult = nil
            try await self.assertSingleCommit(view, before, text: "AXB")
        }
    }

    func testAppliedPatchesNeverEchoAsNativeInput() async throws {
        try await fixture(["AB"]) { view, before in
            let notification = expectation(description: "no native input callback")
            notification.isInverted = true
            view.input.onResult = { _ in notification.fulfill() }
            _ = try await self.send(view, .nativeEdit(revision: before.revision!,
                edits: [NativeSessionEdit(node: before.nodes[0].id, fromUtf16: 1, toUtf16: 1, text: "X")], now: 0))
            _ = try await self.read(view)
            await fulfillment(of: [notification], timeout: 0.1)
            XCTAssertEqual(view.textView.string, "AXB")
            XCTAssertEqual(view.input.acceptedCount, 0)
            view.input.onResult = nil
        }
    }

    func testInvalidScalarAndCrossBlockTargetsRejectWithoutMutation() async throws {
        try await fixture(["A🦀B", "CD"]) { view, before in
            for range in [NSRange(location: 2, length: 0), NSRange(location: 1, length: 1),
                          NSRange(location: 3, length: 3)] {
                XCTAssertFalse(view.textView.shouldChangeText(in: range, replacementString: "bad"))
            }
            let after = try await self.read(view)
            XCTAssertEqual(after.revision, before.revision)
            XCTAssertEqual(view.textView.string, "A🦀B\nCD")
            XCTAssertEqual(view.input.acceptedCount, 0)
        }
    }

    func testDisposeSuppressesPendingInputDelivery() async throws {
        try await fixture(["AB"]) { view, _ in
            let callback = expectation(description: "no disposed callback")
            callback.isInverted = true
            view.input.onResult = { _ in callback.fulfill() }
            view.textView.insertText("X", replacementRange: NSRange(location: 1, length: 0))
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            await fulfillment(of: [callback], timeout: 0.1)
            XCTAssertTrue(view.isDisposed)
            XCTAssertFalse(view.textView.isEditable)
            XCTAssertEqual(view.input.acceptedCount, 0)
        }
    }
}
