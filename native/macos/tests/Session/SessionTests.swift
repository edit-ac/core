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
}
