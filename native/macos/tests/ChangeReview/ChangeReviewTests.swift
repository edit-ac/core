import AppKit
import XCTest
@testable import EditacMacOS

private struct TestFailure: Error {}

@MainActor
final class ChangeReviewTests: XCTestCase {
    struct Harness {
        let owner: NativeSessionExecutor
        let options: NativeSessionOptions
        let review: NativeChangeReviewController
        let initial: NativeSessionRead
    }
    private func harness() async throws -> Harness {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-review-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let options = NativeSessionOptions(path: directory.appendingPathComponent("document.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil)
        let owner = NativeSessionExecutor()
        let initial = try await open(owner, options, create: true)
        let review = NativeChangeReviewController(session: owner,
            view: NativeChangeReviewView(frame: NSRect(x: 0, y: 0, width: 700, height: 500)))
        addTeardownBlock { @MainActor in
            review.dispose()
            await self.close(owner)
            try? FileManager.default.removeItem(at: directory)
        }
        return Harness(owner: owner, options: options, review: review, initial: initial)
    }
    private func open(_ owner: NativeSessionExecutor, _ options: NativeSessionOptions, create: Bool) async throws -> NativeSessionRead {
        let response: NativeSessionResponse = try await withCheckedThrowingContinuation { continuation in
            do {
                try owner.open(options: options, initial: create ? [.init(kind: "block", text: "A🦀B")] : nil, now: 0) {
                    continuation.resume(with: $0.mapError { $0 as Error })
                }
            } catch { continuation.resume(throwing: error) }
        }
        guard case let .snapshot(value) = response else { throw TestFailure() }; return value
    }
    private func send(_ owner: NativeSessionExecutor, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { continuation in
            do { try owner.submit(request) { continuation.resume(with: $0.mapError { $0 as Error }) } }
            catch { continuation.resume(throwing: error) }
        }
    }
    private func read(_ owner: NativeSessionExecutor) async throws -> NativeSessionRead {
        guard case let .snapshot(value) = try await send(owner, .read(now: 0)) else { throw TestFailure() }; return value
    }
    private func capture(_ h: Harness, _ read: NativeSessionRead, name: String = "untrusted author label", key: String? = nil) async throws -> NativeReviewRevision {
        try await withCheckedThrowingContinuation { continuation in
            h.review.capture(revision: read.revision!, name: name, requiredKeyProfile: key) {
                continuation.resume(with: $0.mapError { $0 as Error })
            }
        }
    }
    private func compare(_ h: Harness, _ before: NativeReviewRevision, _ after: NativeReviewRevision,
                         beforeKey: String? = nil, afterKey: String? = nil,
                         attribution: NativeChangeReviewPresentation.Attribution = .unknown,
                         maxBytes: UInt64 = 16 * 1024 * 1024) async {
        await withCheckedContinuation { continuation in
            h.review.compare(before: before, after: after, beforeKeyProfile: beforeKey, afterKeyProfile: afterKey,
                attribution: attribution, maxBytes: maxBytes) { continuation.resume() }
        }
    }
    private func edit(_ h: Harness, _ current: NativeSessionRead, text: String = "e\u{301}🙂") async throws -> NativeSessionRead {
        _ = try await send(h.owner, .nativeEdit(revision: current.revision!, edits: [
            .init(node: current.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: text)], now: 0))
        return try await read(h.owner)
    }
    private func close(_ owner: NativeSessionExecutor) async {
        await withCheckedContinuation { continuation in owner.dispose { continuation.resume() } }
    }
    private func ready(_ review: NativeChangeReviewController, file: StaticString = #filePath, line: UInt = #line) {
        guard case .ready = review.state else { XCTFail("Review not ready: \(review.state)", file: file, line: line); return }
    }

    func testActualCaptureReadComparePreservesSemanticPayloadNavigationAndHistory() async throws {
        let h = try await harness()
        let before = try await capture(h, h.initial, name: "Before 🙂")
        let edited = try await edit(h, h.initial)
        let after = try await capture(h, edited, name: "After e\u{301}")
        var histories: [NativeSessionHistory] = []
        h.owner.onProjection = { if case let .success(update) = $0, let value = update.history { histories.append(value) } }
        let live = try await read(h.owner)
        let history = try XCTUnwrap(histories.last)
        await compare(h, before, after)
        ready(h.review)
        let v = h.review.view
        XCTAssertTrue(v.title.stringValue.contains("Attribution: unknown"))
        XCTAssertTrue(v.title.stringValue.contains("Before 🙂 → After e\u{301}"))
        XCTAssertTrue(v.title.stringValue.contains(after.moduleProfile))
        XCTAssertTrue(v.textView.string.contains("A🦀B"))
        XCTAssertTrue(v.textView.string.contains("Ae\u{301}🙂B"))
        XCTAssertTrue(v.textView.string.contains("before")); XCTAssertTrue(v.textView.string.contains("after"))
        XCTAssertTrue(v.navigate(to: 0)); XCTAssertGreaterThan(v.textView.selectedRange().length, 0)
        let selected = (v.textView.string as NSString).substring(with: v.textView.selectedRange())
        XCTAssertTrue(selected.contains("before"))
        v.textView.insertText("forbidden", replacementRange: v.textView.selectedRange())
        XCTAssertFalse(v.textView.isEditable); XCTAssertFalse(v.textView.string.contains("forbidden"))
        let unchanged = try await read(h.owner)
        XCTAssertEqual(unchanged, live); XCTAssertEqual(histories.last, history)
        XCTAssertEqual(history.undoGroups, 1)
        // A real undo proves review never rewound/committed the live replica.
        _ = try await send(h.owner, .undo(revision: unchanged.revision!, now: 0))
        let undone = try await read(h.owner); XCTAssertEqual(undone.nodes[0].text, h.initial.nodes[0].text)
    }

    func testTrustedHostEvidenceStaysSeparateFromActualPortablePayload() async throws {
        let h = try await harness(); let before = try await capture(h, h.initial)
        let edited = try await edit(h, h.initial); let after = try await capture(h, edited)
        await compare(h, before, after, attribution: .trustedHostEvidence("verified host event #7"))
        ready(h.review)
        XCTAssertTrue(h.review.view.title.stringValue.contains("Trusted host evidence: verified host event #7"))
        XCTAssertFalse(h.review.view.textView.string.contains("verified host event"))
        XCTAssertTrue(h.review.view.title.stringValue.contains("untrusted author label"))
        guard case let .reviewComparison(.available(model)) = try await send(h.owner,
            .compareReviewRevisions(before: before, after: after, beforeKeyProfile: nil, afterKeyProfile: nil, maxBytes: 1_000_000))
        else { throw TestFailure() }
        XCTAssertEqual(model.attribution, "unknown")
    }

    func testLiveAdvanceRetainsHistoricalContentAndDetachedNavigation() async throws {
        let h = try await harness(); let before = try await capture(h, h.initial)
        let edited = try await edit(h, h.initial); let after = try await capture(h, edited)
        await compare(h, before, after); ready(h.review)
        XCTAssertTrue(h.review.view.status.stringValue.contains("Current revision"))
        let content = h.review.view.textView.string
        let advanced = try await edit(h, edited, text: "changed")
        await withCheckedContinuation { continuation in h.review.refreshCurrent { continuation.resume() } }
        XCTAssertTrue(h.review.view.status.stringValue.contains("Stale revision"))
        XCTAssertEqual(h.review.view.textView.string, content); XCTAssertTrue(h.review.view.navigate(to: 0))
        let live = try await read(h.owner); XCTAssertEqual(live, advanced)
    }

    func testTwoViewsAndIndependentSessionsDoNotShareStateOrDisposeOwner() async throws {
        let h = try await harness(); let other = try await harness()
        let before = try await capture(h, h.initial); let edited = try await edit(h, h.initial)
        let after = try await capture(h, edited)
        let second = NativeChangeReviewController(session: h.owner, view: NativeChangeReviewView(frame: .zero))
        defer { second.dispose() }
        await compare(h, before, after)
        await withCheckedContinuation { continuation in second.compare(before: before, after: after) { continuation.resume() } }
        ready(second)
        XCTAssertTrue(h.review.view.navigate(to: 0)); XCTAssertNil(second.view.selectedChange)
        let content = second.view.textView.string
        h.review.dispose(); XCTAssertTrue(h.review.view.textView.string.isEmpty)
        XCTAssertEqual(second.view.textView.string, content); XCTAssertTrue(second.view.navigate(to: 0))
        let live = try await read(h.owner); XCTAssertEqual(live, edited)
        let foreign = try await capture(other, other.initial)
        await compare(other, before, foreign)
        guard case .unavailable(.before, .missing) = other.review.state else { throw TestFailure() }
        let isolated = try await read(other.owner); XCTAssertEqual(isolated, other.initial)
    }

    func testMissingPrunedIncompatibleAndKeyUnavailableStayTypedAndVisible() async throws {
        let h = try await harness(); let before = try await capture(h, h.initial)
        let edited = try await edit(h, h.initial); let after = try await capture(h, edited)
        await compare(h, before, after); ready(h.review)
        let content = h.review.view.textView.string
        let locked = try await capture(h, edited, key: "key-v1")
        await compare(h, before, locked)
        guard case .unavailable(.after, .keyUnavailable) = h.review.state else { throw TestFailure() }
        XCTAssertTrue(h.review.view.status.stringValue.contains("keyUnavailable"))
        XCTAssertEqual(h.review.view.textView.string, content)
        await compare(h, before, locked, afterKey: "key-v1"); ready(h.review)
        var incompatible = after; incompatible.schema = "unsupported-schema"
        await compare(h, before, incompatible)
        guard case .unavailable(.after, .incompatibleSchema) = h.review.state else { throw TestFailure() }
        let other = try await harness()
        let missing = try await capture(other, other.initial)
        await compare(h, missing, after)
        guard case .unavailable(.before, .missing) = h.review.state else { throw TestFailure() }
        _ = try await send(h.owner, .setReviewRetention(maxRevisions: 0, maxTotalBytes: 0))
        await compare(h, before, after)
        guard case .unavailable(.before, .pruned) = h.review.state else { throw TestFailure() }
        XCTAssertEqual(h.review.view.textView.string, content); XCTAssertTrue(h.review.view.navigate(to: 0))
    }

    func testStaleCaptureAndResourceLimitDoNotMutateOrEraseReview() async throws {
        let h = try await harness(); let before = try await capture(h, h.initial)
        let edited = try await edit(h, h.initial); let after = try await capture(h, edited)
        await compare(h, before, after); ready(h.review)
        let content = h.review.view.textView.string
        do { _ = try await capture(h, h.initial); XCTFail("Stale capture accepted") }
        catch NativeSessionFailure.native(.Revision(reason: .stale, message: _)) {}
        await compare(h, before, after, maxBytes: 1)
        guard case .failed(.native(.ResourceLimit)) = h.review.state else { throw TestFailure() }
        XCTAssertEqual(h.review.view.textView.string, content)
        XCTAssertTrue(h.review.view.status.stringValue.contains("ResourceLimit"))
        let live = try await read(h.owner); XCTAssertEqual(live, edited)
    }

    func testReopenKeepsSQLiteDocumentButReportsProcessLocalRevisionsMissing() async throws {
        let h = try await harness(); let before = try await capture(h, h.initial)
        let edited = try await edit(h, h.initial); let after = try await capture(h, edited)
        await compare(h, before, after); ready(h.review)
        h.review.dispose(); await close(h.owner)
        let reopened = NativeSessionExecutor()
        let restored = try await open(reopened, h.options, create: false)
        XCTAssertEqual(restored.nodes, edited.nodes); XCTAssertEqual(restored.pendingUpload, edited.pendingUpload)
        let review = NativeChangeReviewController(session: reopened, view: NativeChangeReviewView(frame: .zero))
        await withCheckedContinuation { continuation in review.compare(before: before, after: after) { continuation.resume() } }
        guard case .unavailable(.before, .missing) = review.state else { throw TestFailure() }
        let fresh: NativeReviewRevision = try await withCheckedThrowingContinuation { continuation in
            review.capture(revision: restored.revision!, name: "Reopened") { continuation.resume(with: $0.mapError { $0 as Error }) }
        }
        await withCheckedContinuation { continuation in review.compare(before: fresh, after: fresh) { continuation.resume() } }
        ready(review); XCTAssertTrue(review.view.textView.string.contains("No changes"))
        review.dispose(); await close(reopened)
    }

    func testReadOnlyCaptureAndQueuedDisposalPreserveOwnerAndSuppressDelivery() async throws {
        let h = try await harness()
        _ = try await send(h.owner, .permission(writable: false, expiresAt: nil))
        let live = try await read(h.owner)
        let revision = try await capture(h, live)
        await compare(h, revision, revision); ready(h.review)
        let after = try await read(h.owner); XCTAssertEqual(after, live)
        let gate = DispatchSemaphore(value: 0); h.owner.enqueueBarrier { gate.wait() }
        h.review.compare(before: revision, after: revision) { XCTFail("Disposed review delivered") }
        h.review.dispose(); gate.signal()
        let final = try await read(h.owner) // Queue barrier proves pending comparison callbacks were drained.
        XCTAssertEqual(final, live); XCTAssertEqual(h.review.view.status.stringValue, "Disposed")
        XCTAssertTrue(h.review.view.textView.string.isEmpty)
    }
}
