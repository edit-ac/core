import AppKit
import XCTest
@testable import EditacMacOS

private struct UnexpectedResponse: Error {}

@MainActor
final class CompositionTests: XCTestCase {
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
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-composition-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
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
            view.input.now = { 0 }; view.composition.now = { 0 }
            try await body(view, snapshot)
        } catch {
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            throw error
        }
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }

    private let absent = NSRange(location: NSNotFound, length: 0)
    private func mark(_ v: NativeEditorView, _ text: String, _ range: NSRange,
                      selection: NSRange? = nil) {
        v.textView.setMarkedText(text, selectedRange: selection ?? NSRange(location: text.utf16.count, length: 0),
                                replacementRange: range)
    }
    private func settle(_ v: NativeEditorView, _ action: () -> Void) async -> Result<Void, NativeInputFailure> {
        await withCheckedContinuation { c in
            v.composition.onResult = { result in v.composition.onResult = nil; c.resume(returning: result) }
            action()
        }
    }
    // A second actual Session/SQLite writer commits outside this view. Recover
    // replays those admitted bytes into the existing owner, preserving anchors
    // and local history. This is actual local delivery, not socket transport.
    private func concurrent(_ v: NativeEditorView, _ range: NSRange, _ text: String) async throws {
        let peer = NativeSessionExecutor()
        do {
            let current: NativeSessionRead = try await withCheckedThrowingContinuation { c in
                do { try peer.open(options: fixtureOptions[ObjectIdentifier(v)]!, now: 0) { result in
                    switch result {
                    case let .success(.snapshot(snapshot)): c.resume(returning: snapshot)
                    case let .failure(error): c.resume(throwing: error)
                    default: c.resume(throwing: UnexpectedResponse())
                    }
                } } catch { c.resume(throwing: error) }
            }
            _ = try await withCheckedThrowingContinuation { (c: CheckedContinuation<NativeSessionResponse, Error>) in
                do { try peer.submit(.nativeEdit(revision: current.revision!, edits: [NativeSessionEdit(
                    node: current.nodes[0].id, fromUtf16: UInt32(range.location),
                    toUtf16: UInt32(NSMaxRange(range)), text: text)], now: 0)) {
                        c.resume(with: $0.mapError { $0 as Error })
                    }
                } catch { c.resume(throwing: error) }
            }
        } catch {
            await withCheckedContinuation { c in peer.dispose { c.resume() } }
            throw error
        }
        await withCheckedContinuation { c in peer.dispose { c.resume() } }
        _ = try await send(v, .recover)
        _ = try await read(v)
    }
    func testProvisionalUpdatesCommitOnceAndUndoAsOneOperation() async throws {
        try await fixture(["AB"]) { v, before in
            self.mark(v, "n", NSRange(location: 1, length: 0))
            self.mark(v, "日本", self.absent)
            XCTAssertTrue(v.textView.hasMarkedText())
            XCTAssertEqual(v.textView.markedRange(), NSRange(location: 1, length: 2))
            XCTAssertEqual(v.textView.string, "A日本B")
            let provisional = try await self.read(v)
            XCTAssertEqual(provisional.nodes[0].text, "AB")
            XCTAssertEqual(provisional.pendingUpload, before.pendingUpload)
            try await self.settle(v) { v.textView.insertText("日本", replacementRange: self.absent) }.get()
            let after = try await self.read(v)
            XCTAssertEqual(after.nodes[0].text, "A日本B")
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
            XCTAssertEqual(v.composition.acceptedCount, 1)
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 3, length: 0))
            v.textView.unmarkText()
            _ = try await self.send(v, .undo(revision: after.revision!, now: 0))
            let undone = try await self.read(v)
            XCTAssertEqual(undone.nodes[0].text, "AB")
        }
    }
    func testCancelRestoresTextSelectionWithoutJournal() async throws {
        try await fixture(["A🦀B"]) { v, before in
            let range = NSRange(location: 1, length: 2)
            v.textView.setSelectedRange(range)
            self.mark(v, "一", self.absent)
            try await self.settle(v) { v.composition.cancel() }.get()
            let after = try await self.read(v)
            XCTAssertEqual(v.textView.string, "A🦀B")
            XCTAssertEqual(v.textView.selectedRange(), range)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertFalse(v.textView.hasMarkedText())
        }
    }
    func testUnmarkFinalizesUnicodeAndMarkedSelection() async throws {
        try await fixture(["אב🦀Z"]) { v, before in
            self.mark(v, "e\u{301}🦀", NSRange(location: 2, length: 2), selection: NSRange(location: 2, length: 2))
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 4, length: 2))
            try await self.settle(v) { v.textView.unmarkText() }.get()
            let after = try await self.read(v)
            XCTAssertEqual(after.nodes[0].text, "אבe\u{301}🦀Z")
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
        }
    }
    func testEmptyAndUnchangedFinalizationsCancel() async throws {
        try await fixture(["cat"]) { v, before in
            self.mark(v, "dog", NSRange(location: 0, length: 3))
            try await self.settle(v) { v.textView.insertText("", replacementRange: self.absent) }.get()
            self.mark(v, "cat", NSRange(location: 0, length: 3))
            try await self.settle(v) { v.textView.unmarkText() }.get()
            let after = try await self.read(v)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertEqual(after.nodes[0].text, "cat")
        }
    }
    func testCapturedReplacementIgnoresCaretAndIsSingleUse() async throws {
        try await fixture(["teh cat"]) { v, before in
            let target = try await v.composition.captureReplacement(range: NSRange(location: 0, length: 3))
            v.textView.setSelectedRange(NSRange(location: 7, length: 0))
            try await self.settle(v) { v.composition.replace(target, with: "the") }.get()
            let after = try await self.read(v)
            XCTAssertEqual(after.nodes[0].text, "the cat")
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
            let repeated = await self.settle(v) { v.composition.replace(target, with: "BAD") }
            if case .success = repeated { XCTFail("Consumed target accepted") }
        }
    }
    func testCapturedReplacementRemapsOutsideChanges() async throws {
        try await fixture(["x teh y"]) { v, _ in
            let target = try await v.composition.captureReplacement(range: NSRange(location: 2, length: 3))
            try await self.concurrent(v, NSRange(location: 0, length: 0), "🦀")
            try await self.settle(v) { v.composition.replace(target, with: "the") }.get()
            XCTAssertEqual(v.textView.string, "🦀x the y")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 7, length: 0))
        }
    }
    func testOverlapRejectsWithoutDeletingConcurrentContent() async throws {
        try await fixture(["teh"]) { v, before in
            self.mark(v, "the", NSRange(location: 0, length: 3))
            try await self.concurrent(v, NSRange(location: 1, length: 1), "X")
            XCTAssertEqual(v.textView.string, "the")
            let result = await self.settle(v) { v.textView.insertText("the", replacementRange: self.absent) }
            if case .success = result { XCTFail("Changed source accepted") }
            let after = try await self.read(v)
            XCTAssertEqual(v.textView.string, "tXh")
            XCTAssertEqual(v.composition.recoveryText, "the")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 0, length: 0))
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
        }
    }
    func testCompositionRetainsTemporaryTextAcrossOutsideChange() async throws {
        try await fixture(["AB"]) { v, _ in
            self.mark(v, "日", NSRange(location: 1, length: 0))
            try await self.concurrent(v, NSRange(location: 0, length: 0), "🦀")
            XCTAssertEqual(v.textView.string, "A日B")
            try await self.settle(v) { v.textView.insertText("日本", replacementRange: self.absent) }.get()
            XCTAssertEqual(v.textView.string, "🦀A日本B")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 5, length: 0))
        }
    }
    func testRevocationCancelsProvisionalInput() async throws {
        try await fixture(["AB"]) { v, before in
            self.mark(v, "日", NSRange(location: 1, length: 0))
            _ = try await self.send(v, .permission(writable: false, expiresAt: nil))
            _ = try await self.read(v)
            _ = try await self.read(v)
            XCTAssertFalse(v.textView.hasMarkedText())
            XCTAssertFalse(v.textView.isEditable)
            XCTAssertEqual(v.textView.string, "AB")
            let after = try await self.read(v)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
        }
    }
    func testForeignAndCancelledTokensCannotMutate() async throws {
        try await fixture(["teh"]) { first, before in
            let target = try await first.composition.captureReplacement(range: NSRange(location: 0, length: 3))
            try await self.fixture(["other"]) { second, _ in
                let result = await self.settle(second) { second.composition.replace(target, with: "BAD") }
                if case .success = result { XCTFail("Foreign target accepted") }
                XCTAssertEqual(second.textView.string, "other")
            }
            first.composition.cancelReplacement(target)
            let result = await self.settle(first) { first.composition.replace(target, with: "BAD") }
            if case .success = result { XCTFail("Cancelled target accepted") }
            let after = try await self.read(first)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
        }
    }
    func testInvalidUnicodeAndCrossBlockRangesReject() async throws {
        try await fixture(["A🦀B", "C"]) { v, before in
            self.mark(v, "日", NSRange(location: 2, length: 0))
            XCTAssertFalse(v.composition.isActive)
            self.mark(v, "日", NSRange(location: 0, length: 6))
            XCTAssertFalse(v.composition.isActive)
            let after = try await self.read(v)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertEqual(v.textView.string, "A🦀B\nC")
        }
    }
    func testDisposalCancelsOwnershipAndSuppressesLateReplacement() async throws {
        try await fixture(["AB"]) { v, _ in
            let target = try await v.composition.captureReplacement(range: NSRange(location: 0, length: 1))
            await withCheckedContinuation { c in v.dispose { c.resume() } }
            v.composition.replace(target, with: "BAD")
            self.mark(v, "日", NSRange(location: 0, length: 0))
            XCTAssertFalse(v.composition.isActive)
            XCTAssertFalse(v.textView.isEditable)
            XCTAssertEqual(v.textView.string, "AB")
        }
    }

    func testCancelRemapsCapturedSelectionAfterPeerInsertion() async throws {
        try await fixture(["x cat y"]) { v, before in
            v.textView.setSelectedRange(NSRange(location: 2, length: 3), affinity: .upstream, stillSelecting: false)
            self.mark(v, "日", self.absent)
            try await self.concurrent(v, NSRange(location: 0, length: 0), "🦀")
            try await self.settle(v) { v.composition.cancel() }.get()
            XCTAssertEqual(v.textView.string, "🦀x cat y")
            XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 4, length: 3))
            XCTAssertEqual(v.textView.selectionAffinity, .upstream)
            let after = try await self.read(v)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
        }
    }
    func testPeerInsertionAtCaretUsesRightAffinityAndUndoPreservesPeer() async throws {
        try await fixture(["AB"]) { v, _ in
            self.mark(v, "日", NSRange(location: 1, length: 0))
            try await self.concurrent(v, NSRange(location: 1, length: 0), "X")
            try await self.settle(v) { v.textView.insertText("日", replacementRange: self.absent) }.get()
            XCTAssertEqual(v.textView.string, "AX日B")
            let after = try await self.read(v)
            _ = try await self.send(v, .undo(revision: after.revision!, now: 0))
            let undone = try await self.read(v)
            XCTAssertEqual(undone.nodes[0].text, "AXB")
        }
    }
    func testDelayedReplacementRechecksPermission() async throws {
        try await fixture(["teh"]) { v, before in
            let target = try await v.composition.captureReplacement(range: NSRange(location: 0, length: 3))
            _ = try await self.send(v, .permission(writable: false, expiresAt: nil))
            let result = await self.settle(v) { v.composition.replace(target, with: "the") }
            if case .success = result { XCTFail("Revoked replacement accepted") }
            let after = try await self.read(v)
            XCTAssertEqual(after.nodes[0].text, "teh")
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertFalse(v.textView.isEditable)
        }
    }
    func testDuplicateFinalWhilePendingCannotCommitTwice() async throws {
        try await fixture(["AB"]) { v, before in
            self.mark(v, "日", NSRange(location: 1, length: 0))
            try await self.settle(v) {
                v.textView.insertText("日", replacementRange: self.absent)
                v.textView.insertText("日", replacementRange: self.absent)
                v.textView.unmarkText()
            }.get()
            let after = try await self.read(v)
            XCTAssertEqual(after.nodes[0].text, "A日B")
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
            XCTAssertEqual(v.composition.acceptedCount, 1)
        }
    }
    func testIdenticalIndependentCompositionsAreDistinctOperations() async throws {
        try await fixture(["AB"]) { v, before in
            for _ in 0..<2 {
                self.mark(v, "日", NSRange(location: 1, length: 0))
                try await self.settle(v) { v.textView.insertText("日", replacementRange: self.absent) }.get()
            }
            let after = try await self.read(v)
            XCTAssertEqual(after.nodes[0].text, "A日日B")
            XCTAssertEqual(after.pendingUpload, before.pendingUpload + 2)
            XCTAssertEqual(v.composition.acceptedCount, 2)
        }
    }
    func testNativeCancelCommandDoesNotCommit() async throws {
        try await fixture(["AB"]) { v, before in
            self.mark(v, "日", NSRange(location: 1, length: 0))
            try await self.settle(v) { v.textView.doCommand(by: #selector(NSResponder.cancelOperation(_:))) }.get()
            let after = try await self.read(v)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertEqual(v.textView.string, "AB")
        }
    }
    func testInvalidMarkedSelectedRangeDoesNotMutate() async throws {
        try await fixture(["AB"]) { v, before in
            self.mark(v, "🦀", NSRange(location: 1, length: 0), selection: NSRange(location: 1, length: 0))
            XCTAssertFalse(v.composition.isActive)
            let after = try await self.read(v)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertEqual(v.textView.string, "AB")
        }
    }
    func testDeletingCapturedSourceRejectsWithRecoveryText() async throws {
        try await fixture(["cat"]) { v, _ in
            self.mark(v, "日", NSRange(location: 0, length: 3))
            try await self.concurrent(v, NSRange(location: 0, length: 3), "")
            let result = await self.settle(v) { v.textView.insertText("日", replacementRange: self.absent) }
            if case .success = result { XCTFail("Deleted source accepted") }
            XCTAssertEqual(v.textView.string, "")
            XCTAssertEqual(v.composition.recoveryText, "日")
        }
    }

    func testDisposalResumesQueuedAsyncCapture() async throws {
        try await fixture(["AB"]) { v, _ in
            let gate = DispatchSemaphore(value: 0)
            v.session.enqueueBarrier { gate.wait() }
            let task = Task { try await v.composition.captureReplacement(range: NSRange(location: 0, length: 1)) }
            await Task.yield()
            XCTAssertEqual(v.composition.pendingCaptureCount, 1)
            v.dispose()
            gate.signal()
            do { _ = try await task.value; XCTFail("Disposed capture returned a target") } catch {}
            XCTAssertEqual(v.composition.pendingCaptureCount, 0)
        }
    }
    func testTaskCancellationResumesQueuedAsyncCaptureAndReleasesTarget() async throws {
        try await fixture(["AB"]) { v, before in
            let gate = DispatchSemaphore(value: 0)
            v.session.enqueueBarrier { gate.wait() }
            let task = Task { try await v.composition.captureReplacement(range: NSRange(location: 0, length: 1)) }
            await Task.yield()
            XCTAssertEqual(v.composition.pendingCaptureCount, 1)
            task.cancel()
            do { _ = try await task.value; XCTFail("Cancelled capture returned a target") } catch {}
            gate.signal()
            let after = try await self.read(v)
            XCTAssertEqual(after.pendingUpload, before.pendingUpload)
            XCTAssertEqual(v.composition.pendingCaptureCount, 0)
        }
    }
}
