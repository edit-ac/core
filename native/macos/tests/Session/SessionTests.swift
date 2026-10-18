import AppKit
import XCTest
@testable import EditacMacOS

private struct TestFailure: Error {}

@MainActor
final class SessionTests: XCTestCase {
    private static var nextFixture = 0

    private func fixture() throws -> (URL, NativeSessionOptions) {
        _ = NSApplication.shared
        Self.nextFixture += 1
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-appkit-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return (directory, NativeSessionOptions(path: directory.appendingPathComponent("document.sqlite").path,
            documentId: String(format: "a9300000-0000-4000-8000-%012d", Self.nextFixture),
            epoch: "a9400000-0000-4000-8000-000000000001", writable: true, permissionExpiresAt: nil))
    }

    private func open(_ owner: NativeSessionExecutor, _ options: NativeSessionOptions,
                      create: Bool = true) async throws -> NativeSessionRead {
        let response: NativeSessionResponse = try await withCheckedThrowingContinuation { continuation in
            do {
                try owner.open(options: options,
                    initial: create ? [NativeSessionSeed(kind: "block", text: "A🦀B")] : nil, now: 0) {
                    continuation.resume(with: $0.mapError { $0 as Error })
                }
            } catch { continuation.resume(throwing: error) }
        }
        guard case let .snapshot(read) = response else { throw TestFailure() }
        return read
    }

    private func send(_ owner: NativeSessionExecutor, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { continuation in
            do { try owner.submit(request) { continuation.resume(with: $0.mapError { $0 as Error }) } }
            catch { continuation.resume(throwing: error) }
        }
    }

    private func read(_ owner: NativeSessionExecutor) async throws -> NativeSessionRead {
        guard case let .snapshot(read) = try await send(owner, .read(now: 0)) else { throw TestFailure() }
        return read
    }

    private func close(_ owner: NativeSessionExecutor) async {
        await withCheckedContinuation { continuation in owner.dispose { continuation.resume() } }
    }

    private func plan(_ owner: NativeSessionExecutor, _ snapshot: NativeSessionRead,
                      text: String = "xy") async throws -> String {
        guard case let .prepared(token) = try await send(owner, .prepare(revision: snapshot.revision!,
            edits: [NativeSessionEdit(node: snapshot.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: text)],
            origin: "appkit-session-test", now: 0)) else { throw TestFailure() }
        return token
    }

    func testRealSessionOpensWithNativeViewAndOwnedSnapshot() async throws {
        _ = NSApplication.shared
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        defer { window.contentView = nil; window.close() }
        let snapshot = try await open(view.session, options)
        XCTAssertTrue(Thread.isMainThread)
        XCTAssertTrue(view.textView.window === window)
        XCTAssertEqual(view.sessionSnapshot, snapshot)
        XCTAssertEqual(view.sessionDeliveryCount, 1)
        XCTAssertEqual(snapshot.nodes.first?.text, "A🦀B")
        XCTAssertEqual(snapshot.localDurability, .processCrash)
        XCTAssertTrue(snapshot.locallyCommitted)
        XCTAssertTrue(view.textView.isEditable) // Shared Session admits committed input.
        await withCheckedContinuation { continuation in view.dispose { continuation.resume() } }
        XCTAssertNil(view.sessionSnapshot)
        XCTAssertEqual(snapshot.nodes.first?.text, "A🦀B") // Owned after disposal.
    }

    func testTypedOpenFailureAllowsRetryWithoutCreatingStore() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor()
        do { _ = try await open(owner, options, create: false); XCTFail("missing store opened") }
        catch NativeSessionFailure.native(.Store(reason: .unavailable)) {} catch { XCTFail("\(error)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: options.path))
        let snapshot = try await open(owner, options)
        XCTAssertEqual(snapshot.nodes[0].text, "A🦀B")
        await close(owner)
    }

    func testDuplicateOpenPreservesOwnerAndDisposeReleasesWriter() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let original = try await open(owner, options)
        do { _ = try await open(owner, options); XCTFail("duplicate owner") }
        catch NativeSessionFailure.alreadyOpen {} catch { XCTFail("\(error)") }
        let competitor = NativeSessionExecutor()
        do { _ = try await open(competitor, options); XCTFail("second initializer") }
        catch NativeSessionFailure.native(.Store(reason: _)) {} catch { XCTFail("\(error)") }
        await close(owner)
        let restored = try await open(competitor, options, create: false)
        XCTAssertEqual(restored.nodes, original.nodes)
        await close(competitor)
    }

    func testOffMainSerialWorkAndMainActorCallbackOrder() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor()
        let workerObservation = await withCheckedContinuation { continuation in
            owner.enqueueBarrier { continuation.resume(returning: Thread.isMainThread) }
        }
        XCTAssertFalse(workerObservation)
        var order: [Int] = []
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                try owner.open(options: options, initial: [NativeSessionSeed(kind: "block", text: "ordered")], now: 0) {
                    XCTAssertTrue(Thread.isMainThread); if case .failure = $0 { XCTFail("open failed") }; order.append(1)
                }
                try owner.submit(.permission(writable: false, expiresAt: nil)) {
                    XCTAssertTrue(Thread.isMainThread); if case .failure = $0 { XCTFail("permission failed") }; order.append(2)
                }
                try owner.submit(.read(now: 0)) { result in
                    XCTAssertTrue(Thread.isMainThread); order.append(3)
                    if case let .success(.snapshot(snapshot)) = result { XCTAssertFalse(snapshot.canApply) }
                    else { XCTFail("read failed") }
                    continuation.resume()
                }
            } catch { continuation.resume(throwing: error) }
        }
        XCTAssertEqual(order, [1, 2, 3])
        await close(owner)
    }

    func testQueuedOpenCancellationDoesNotCreateOrLeakOwner() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let gate = DispatchSemaphore(value: 0)
        owner.enqueueBarrier { gate.wait() }
        let result: Result<NativeSessionResponse, NativeSessionFailure> = try await withCheckedThrowingContinuation { continuation in
            do {
                let operation = try owner.open(options: options, initial: [], now: 0) { continuation.resume(returning: $0) }
                XCTAssertTrue(operation.cancel()); gate.signal()
            } catch { gate.signal(); continuation.resume(throwing: error) }
        }
        if case .failure(.cancelled) = result {} else { XCTFail("cancel not delivered") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: options.path))
        do { _ = try await read(owner); XCTFail("cancelled open retained owner") }
        catch NativeSessionFailure.notOpen {} catch { XCTFail("\(error)") }
        _ = try await open(owner, options)
        await close(owner)
    }

    func testQueuedReadCancellationKeepsOrderedSessionUsable() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); _ = try await open(owner, options)
        let gate = DispatchSemaphore(value: 0); owner.enqueueBarrier { gate.wait() }
        var order: [String] = []
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                let operation = try owner.submit(.read(now: 0)) { result in
                    if case .failure(.cancelled) = result { order.append("cancelled") } else { XCTFail("wrong result") }
                }
                XCTAssertTrue(operation.cancel())
                try owner.submit(.read(now: 0)) { result in
                    if case .success(.snapshot) = result { order.append("read") } else { XCTFail("owner lost") }
                    continuation.resume()
                }
                gate.signal()
            } catch { gate.signal(); continuation.resume(throwing: error) }
        }
        XCTAssertEqual(order, ["cancelled", "read"])
        await close(owner)
    }

    func testCancellationAfterAcceptanceCannotUndoCommittedWork() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let snapshot = try await open(owner, options)
        let token = try await plan(owner, snapshot)
        let operation: NativeSessionOperation = try await withCheckedThrowingContinuation { continuation in
            do {
                // Capture the operation via a main-actor box, since the callback is asynchronous.
                var submitted: NativeSessionOperation?
                submitted = try owner.submit(.commit(token: token, now: 0)) { result in
                    if case let .success(.committed(receipt)) = result { XCTAssertNotNil(receipt) }
                    else { XCTFail("commit failed") }
                    continuation.resume(returning: submitted!)
                }
            } catch { continuation.resume(throwing: error) }
        }
        XCTAssertFalse(operation.cancel())
        let after = try await read(owner); XCTAssertEqual(after.nodes[0].text, "AxyB")
        await close(owner)
    }

    func testPreparedCancellationAndTypedFailurePreserveSnapshot() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let before = try await open(owner, options)
        let token = try await plan(owner, before)
        _ = try await send(owner, .cancelPrepared(token: token))
        do { _ = try await send(owner, .commit(token: token, now: 0)); XCTFail("cancelled plan committed") }
        catch NativeSessionFailure.native(_) {} catch { XCTFail("\(error)") }
        let after = try await read(owner)
        XCTAssertEqual(after.nodes, before.nodes); XCTAssertEqual(after.revision, before.revision)
        await close(owner)
    }

    func testQueuedCommitCancellationPreservesDurableState() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let before = try await open(owner, options)
        let token = try await plan(owner, before)
        let gate = DispatchSemaphore(value: 0); owner.enqueueBarrier { gate.wait() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                let operation = try owner.submit(.commit(token: token, now: 0)) { result in
                    if case .failure(.cancelled) = result {} else { XCTFail("cancelled commit executed") }
                    continuation.resume()
                }
                XCTAssertTrue(operation.cancel()); gate.signal()
            } catch { gate.signal(); continuation.resume(throwing: error) }
        }
        let after = try await read(owner); XCTAssertEqual(after.nodes, before.nodes)
        _ = try await send(owner, .cancelPrepared(token: token))
        await close(owner)
        let restored = NativeSessionExecutor(); let persisted = try await open(restored, options, create: false)
        XCTAssertEqual(persisted.nodes, before.nodes); await close(restored)
    }

    func testDisposalSuppressesQueuedViewCallbacksAndIsIdempotent() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let view = NativeEditorView(frame: .zero); _ = try await open(view.session, options)
        let delivered = view.sessionDeliveryCount
        let gate = DispatchSemaphore(value: 0); view.session.enqueueBarrier { gate.wait() }
        try view.session.submit(.read(now: 0)) { _ in XCTFail("disposed completion") }
        await withCheckedContinuation { continuation in
            view.dispose { continuation.resume() }; gate.signal()
        }
        await close(view.session)
        XCTAssertTrue(view.isDisposed); XCTAssertNil(view.sessionSnapshot)
        XCTAssertEqual(view.sessionDeliveryCount, delivered)
        XCTAssertThrowsError(try view.session.submit(.read(now: 0))) {
            guard case NativeSessionFailure.disposed = $0 else { return XCTFail("\($0)") }
        }
        let restored = NativeSessionExecutor(); _ = try await open(restored, options, create: false); await close(restored)
    }

    func testReleasedViewIsNotRetainedByInFlightDelivery() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        var view: NativeEditorView? = NativeEditorView(frame: .zero)
        weak var released = view
        let owner = view!.session; _ = try await open(owner, options)
        let gate = DispatchSemaphore(value: 0); owner.enqueueBarrier { gate.wait() }
        try owner.submit(.read(now: 0))
        view = nil
        XCTAssertNil(released)
        gate.signal()
        let after = try await read(owner); XCTAssertEqual(after.nodes[0].text, "A🦀B")
        XCTAssertNil(released)
        await close(owner)
    }

    func testReentrantDisposeSuppressesCompletionAndLaterResults() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); _ = try await open(owner, options)
        await withCheckedContinuation { continuation in
            owner.onResult = { _ in owner.dispose { continuation.resume() } }
            do {
                try owner.submit(.read(now: 0)) { _ in XCTFail("completion after reentrant disposal") }
                try owner.submit(.read(now: 0)) { _ in XCTFail("later result after disposal") }
            } catch { XCTFail("\(error)"); continuation.resume() }
        }
        let restored = NativeSessionExecutor(); _ = try await open(restored, options, create: false); await close(restored)
    }

    private func reviewCapture(_ owner: NativeSessionExecutor, _ revision: Data,
                               key: String? = nil) async throws -> NativeReviewRevision {
        guard case let .reviewRevision(value) = try await send(owner,
            .captureReviewRevision(revision: revision, name: "untrusted-host-label", requiredKeyProfile: key))
        else { throw TestFailure() }
        return value
    }

    private func reviewBytes(_ owner: NativeSessionExecutor, _ revision: NativeReviewRevision) async throws -> Data {
        guard case let .reviewRead(.available(_, bytes)) = try await send(owner,
            .readReviewRevision(revision: revision, availableKeyProfile: nil)) else { throw TestFailure() }
        return bytes
    }

    func testReviewReadOnlyRoundTripUsesActualSessionAndOwnedModel() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let initial = try await open(owner, options)
        _ = try await send(owner, .permission(writable: false, expiresAt: nil))
        let before = try await read(owner)
        var projections = 0; owner.onProjection = { _ in projections += 1 }
        let revision = try await reviewCapture(owner, initial.revision!)
        let bytes = try await reviewBytes(owner, revision)
        guard case let .reviewComparison(.available(model)) = try await send(owner,
            .compareReviewRevisions(before: revision, after: revision, beforeKeyProfile: nil,
                                    afterKeyProfile: nil, maxBytes: 16 * 1024 * 1024)) else { throw TestFailure() }
        guard case let .changeModel(validated) = try await send(owner,
            .validateChangeModel(bytes: model.json, maxBytes: 16 * 1024 * 1024)) else { throw TestFailure() }
        XCTAssertEqual(validated, model)
        let after = try await read(owner)
        XCTAssertEqual(before, after); XCTAssertEqual(projections, 1) // Only the explicit read projects.
        await close(owner)
        XCTAssertFalse(bytes.isEmpty); XCTAssertFalse(model.json.isEmpty)
        let reopened = NativeSessionExecutor(); let restored = try await open(reopened, options, create: false)
        XCTAssertEqual(restored.nodes, initial.nodes); await close(reopened)
    }

    func testReviewErrorsAndUnavailableStatesPreserveTypedResults() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let before = try await open(owner, options)
        let locked = try await reviewCapture(owner, before.revision!, key: "key-v1")
        guard case .reviewRead(.unavailable(.keyUnavailable)) = try await send(owner,
            .readReviewRevision(revision: locked, availableKeyProfile: "key-v2")) else { throw TestFailure() }
        let token = try await plan(owner, before)
        _ = try await send(owner, .commit(token: token, now: 0))
        do { _ = try await reviewCapture(owner, before.revision!); XCTFail("stale capture accepted") }
        catch NativeSessionFailure.native(.Revision(reason: .stale, message: _)) {}
        do { _ = try await send(owner, .validateChangeModel(bytes: Data("invalid".utf8), maxBytes: 1024)); XCTFail("malformed accepted") }
        catch NativeSessionFailure.native(.ReviewInput(reason: .invalid)) {}
        do { _ = try await send(owner, .compareReviewRevisions(before: locked, after: locked,
            beforeKeyProfile: "key-v1", afterKeyProfile: "key-v1", maxBytes: 1)); XCTFail("limit ignored") }
        catch NativeSessionFailure.native(.ResourceLimit) {}
        _ = try await send(owner, .setReviewRetention(maxRevisions: 0, maxTotalBytes: 0))
        guard case .reviewRead(.unavailable(.pruned)) = try await send(owner,
            .readReviewRevision(revision: locked, availableKeyProfile: "key-v1")) else { throw TestFailure() }
        await close(owner)
    }

    func testReviewTwoSessionIsolationRejectsForeignBindings() async throws {
        let (directoryA, optionsA) = try fixture(); defer { try? FileManager.default.removeItem(at: directoryA) }
        let (directoryB, optionsB) = try fixture(); defer { try? FileManager.default.removeItem(at: directoryB) }
        let a = NativeSessionExecutor(), b = NativeSessionExecutor()
        let beforeA = try await open(a, optionsA), beforeB = try await open(b, optionsB)
        let revisionA = try await reviewCapture(a, beforeA.revision!)
        let revisionB = try await reviewCapture(b, beforeB.revision!)
        let ownedA = try await reviewBytes(a, revisionA), ownedB = try await reviewBytes(b, revisionB)
        guard case .reviewRead(.unavailable(.missing)) = try await send(b,
            .readReviewRevision(revision: revisionA, availableKeyProfile: nil)) else { throw TestFailure() }
        guard case .reviewComparison(.unavailable(.after, .missing)) = try await send(a,
            .compareReviewRevisions(before: revisionA, after: revisionB, beforeKeyProfile: nil,
                                    afterKeyProfile: nil, maxBytes: 16 * 1024 * 1024)) else { throw TestFailure() }
        let afterA = try await read(a), afterB = try await read(b)
        XCTAssertEqual(beforeA, afterA); XCTAssertEqual(beforeB, afterB)
        await close(a)
        let stillOwnedB = try await reviewBytes(b, revisionB)
        XCTAssertEqual(stillOwnedB, ownedB); XCTAssertFalse(ownedA.isEmpty)
        await close(b)
    }

    func testQueuedReviewCancellationPreventsRetentionWork() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor(); let before = try await open(owner, options)
        let revision = try await reviewCapture(owner, before.revision!)
        let bytes = try await reviewBytes(owner, revision)
        let gate = DispatchSemaphore(value: 0); owner.enqueueBarrier { gate.wait() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                let operation = try owner.submit(.setReviewRetention(maxRevisions: 0, maxTotalBytes: 0)) { result in
                    if case .failure(.cancelled) = result {} else { XCTFail("cancelled review executed") }
                    continuation.resume()
                }
                XCTAssertTrue(operation.cancel()); gate.signal()
            } catch { gate.signal(); continuation.resume(throwing: error) }
        }
        let retained = try await reviewBytes(owner, revision)
        XCTAssertEqual(retained, bytes); await close(owner)
    }

    func testReviewDisposalSuppressesDeliveryAndRejectsAdmission() async throws {
        let (directory, options) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = NativeSessionExecutor()
        do { _ = try await send(owner, .validateChangeModel(bytes: Data(), maxBytes: 1)); XCTFail("unopened owner accepted") }
        catch NativeSessionFailure.notOpen {}
        let before = try await open(owner, options)
        let revision = try await reviewCapture(owner, before.revision!)
        let owned = try await reviewBytes(owner, revision)
        let gate = DispatchSemaphore(value: 0); owner.enqueueBarrier { gate.wait() }
        try owner.submit(.readReviewRevision(revision: revision, availableKeyProfile: nil)) { _ in XCTFail("disposed completion") }
        await withCheckedContinuation { continuation in
            owner.dispose { continuation.resume() }; gate.signal()
        }
        XCTAssertThrowsError(try owner.submit(.readReviewRevision(revision: revision, availableKeyProfile: nil))) {
            guard case NativeSessionFailure.disposed = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertFalse(owned.isEmpty); await close(owner)
    }

}
