import AppKit
import XCTest
@testable import EditacMacOS

private struct Unexpected: Error {}

/// Actual local Session/SQLite/AppKit integration. No transport, presence or
/// reconnect claim: those original DSK-1.15 criteria remain a separate gate.
@MainActor
final class CollaborationLifecycleTests: XCTestCase {
    private func fixture() throws -> (URL, NativeSessionOptions, NativeSessionOptions) {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editac-native-switch-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        func options(_ name: String) -> NativeSessionOptions {
            NativeSessionOptions(path: root.appendingPathComponent(name + ".sqlite").path,
                documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
                writable: true, permissionExpiresAt: nil)
        }
        return (root, options("old"), options("new"))
    }
    private func open(_ options: NativeSessionOptions, create: Bool = true) async throws -> NativeEditorView {
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            do { try view.session.open(options: options,
                initial: create ? [NativeSessionSeed(kind: "block", text: "A🦀B")] : nil, now: 0) {
                    c.resume(with: $0.mapError { $0 as Error })
                }
            } catch { c.resume(throwing: error) }
        }
        return view
    }
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { c in
            do { try view.session.submit(request) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }
    private func read(_ view: NativeEditorView) async throws -> NativeSessionRead {
        guard case let .snapshot(value) = try await send(view, .read(now: 0)) else { throw Unexpected() }
        return value
    }
    private func edit(_ view: NativeEditorView, _ text: String) async throws {
        let before = try await read(view)
        _ = try await send(view, .nativeEdit(revision: before.revision!, edits: [NativeSessionEdit(
            node: before.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: text)], now: 0))
    }
    private func change(_ host: NativeDocumentCoordinator, _ options: NativeSessionOptions,
                        create: Bool = true) async throws -> NativeEditorView {
        try await withCheckedThrowingContinuation { c in
            host.switchDocument(options: options, initial: create ? [NativeSessionSeed(kind: "block", text: "new")] : nil,
                now: 0) { c.resume(with: $0.mapError { $0 as Error }) }
        }
    }
    private func revoke(_ host: NativeDocumentCoordinator) async throws {
        let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            host.revoke(now: 0) { c.resume(with: $0.mapError { $0 as Error }) }
        }
    }
    private func close(_ host: NativeDocumentCoordinator) async throws {
        try await withCheckedThrowingContinuation { c in host.close { c.resume(with: $0.mapError { $0 as Error }) } }
    }
    private func dispose(_ view: NativeEditorView) async {
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }
    private func sql(_ options: NativeSessionOptions, _ statement: String) throws {
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [options.path, statement]
        let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
        try process.run(); process.waitUntilExit()
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard process.terminationStatus == 0 else { XCTFail(output); throw Unexpected() }
    }

    func testSwitchPreservesOldDurableReceiptAndOfflineRestore() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view)
        try await edit(view, "saved")
        let saved = try await read(view); let receipt = try XCTUnwrap(view.storage.status.receipt)
        XCTAssertTrue(saved.locallyCommitted); XCTAssertGreaterThan(saved.pendingUpload, 0)
        let replacement = try await change(host, next)
        XCTAssertTrue(view.isDisposed); XCTAssertTrue(host.editor === replacement)
        XCTAssertEqual(replacement.textView.string, "new"); XCTAssertEqual(host.phase, .ready)
        let restored = try await open(old, create: false); let after = try await read(restored)
        XCTAssertEqual(after.nodes, saved.nodes); XCTAssertEqual(after.pendingUpload, saved.pendingUpload)
        XCTAssertEqual(after.revision, saved.revision); XCTAssertTrue(after.locallyCommitted)
        // Local commit proof never becomes a remote acknowledgment.
        XCTAssertEqual(receipt.sequence, 1); XCTAssertEqual(receipt.checksum.count, 32)
        XCTAssertNil(view.storage.status.receipt)
        try await close(host); await dispose(restored)
    }

    func testRevocationCancelsMarkedTextAndPreservesNativeSelection() async throws {
        let (root, old, _) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view)
        view.textView.setSelectedRange(NSRange(location: 1, length: 2), affinity: .upstream, stillSelecting: false)
        view.textView.setMarkedText("provisional", selectedRange: NSRange(location: 3, length: 0),
                                    replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(view.composition.isActive)
        try await revoke(host)
        let state = try await read(view)
        XCTAssertEqual(state.nodes[0].text, "A🦀B"); XCTAssertFalse(state.canApply)
        XCTAssertFalse(view.composition.isActive); XCTAssertFalse(view.composition.isPending)
        XCTAssertEqual(view.textView.string, "A🦀B")
        XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 1, length: 2))
        XCTAssertEqual(view.textView.selectionAffinity, .upstream)
        XCTAssertFalse(view.textView.isEditable); XCTAssertNotEqual(view.commands.availability(.undo), .enabled)
        try await close(host)
    }

    func testRevocationRetainsAcceptedReceiptAndRejectsEditAndUndo() async throws {
        let (root, old, _) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view)
        try await edit(view, "saved"); let saved = try await read(view)
        let receipt = try XCTUnwrap(view.storage.status.receipt)
        try await revoke(host)
        do { try await edit(view, "denied"); XCTFail("revoked edit accepted") } catch NativeSessionFailure.native(_) {}
        do { _ = try await send(view, .undo(revision: saved.revision!, now: 0)); XCTFail("revoked undo accepted") }
        catch NativeSessionFailure.native(_) {}
        let after = try await read(view)
        XCTAssertEqual(after.nodes, saved.nodes); XCTAssertEqual(after.pendingUpload, saved.pendingUpload)
        XCTAssertEqual(view.storage.status.receipt?.sequence, receipt.sequence)
        XCTAssertTrue(after.locallyCommitted); XCTAssertFalse(after.canApply)
        try await close(host)
    }

    func testLateOSReplacementCannotReviveAfterPolicyRenewal() async throws {
        let (root, old, _) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view)
        let captured = try await view.composition.captureReplacement(range: NSRange(location: 1, length: 2))
        try await revoke(host)
        _ = try await send(view, .commandPermission(writable: true, expiresAt: nil, now: 0))
        view.composition.replace(captured, with: "late")
        let after = try await read(view)
        XCTAssertEqual(after.nodes[0].text, "A🦀B"); XCTAssertTrue(after.canApply)
        let fresh = try await view.composition.captureReplacement(range: NSRange(location: 1, length: 2))
        view.composition.replace(fresh, with: "fresh")
        let changed = try await read(view); XCTAssertEqual(changed.nodes[0].text, "AfreshB")
        try await close(host)
    }

    func testRevocationResumesInFlightCaptureAndInvalidatesScopeImmediately() async throws {
        let (root, old, _) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view); let scope = host.scope
        let gate = DispatchSemaphore(value: 0); view.session.enqueueBarrier { gate.wait() }
        let capture = Task { try await view.composition.captureReplacement(range: NSRange(location: 1, length: 2)) }
        await Task.yield(); XCTAssertEqual(view.composition.pendingCaptureCount, 1)
        let revoked = expectation(description: "revocation settles")
        host.revoke(now: 0) { result in if case .failure = result { XCTFail("revocation failed") }; revoked.fulfill() }
        XCTAssertFalse(host.deliver(ifCurrent: scope) { _ in XCTFail("old host callback delivered") })
        gate.signal()
        do { _ = try await capture.value; XCTFail("invalid capture survived") } catch {}
        await fulfillment(of: [revoked], timeout: 5)
        XCTAssertEqual(view.composition.pendingCaptureCount, 0)
        try await close(host)
    }

    func testFailedCandidateOpenPreservesOldCompositionAndScope() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let corrupt = Data("invalid sqlite".utf8); try corrupt.write(to: URL(fileURLWithPath: next.path))
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view); let scope = host.scope
        view.textView.setMarkedText("draft", selectedRange: NSRange(location: 1, length: 0),
                                    replacementRange: NSRange(location: 1, length: 2))
        do { _ = try await change(host, next, create: false); XCTFail("corrupt candidate opened") }
        catch NativeSessionFailure.native(_) {}
        XCTAssertTrue(host.editor === view); XCTAssertFalse(view.isDisposed); XCTAssertTrue(view.composition.isActive)
        XCTAssertTrue(host.deliver(ifCurrent: scope) { XCTAssertTrue($0 === view) })
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: next.path)), corrupt)
        try await close(host)
    }

    func testCancelledCandidateWaitsForDisposalAndCompletesOnce() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view); let scope = host.scope
        let done = expectation(description: "cancelled completion"); done.assertForOverFulfill = true
        host.switchDocument(options: next, initial: [NativeSessionSeed(kind: "block", text: "candidate")], now: 0) { result in
            guard case .failure(.cancelled) = result else { XCTFail("expected cancellation"); done.fulfill(); return }
            done.fulfill()
        }
        XCTAssertTrue(host.cancelSwitch()); XCTAssertFalse(host.cancelSwitch())
        await fulfillment(of: [done], timeout: 5)
        _ = try await read(view)
        XCTAssertTrue(host.editor === view); XCTAssertEqual(host.phase, .ready)
        XCTAssertTrue(host.deliver(ifCurrent: scope) { _ in })
        // Candidate disposal completed; if creation was accepted it can be reopened.
        if FileManager.default.fileExists(atPath: next.path) {
            let restored = try await open(next, create: false); await dispose(restored)
        }
        try await close(host)
    }

    func testSwitchRejectsConcurrentSwitchAndRevocation() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view)
        let done = expectation(description: "switch completion")
        host.switchDocument(options: next, initial: [NativeSessionSeed(kind: "block", text: "next")], now: 0) { result in
            if case .failure = result { XCTFail("switch failed") }; done.fulfill()
        }
        host.switchDocument(options: next, now: 0) { result in
            guard case .failure(.closing) = result else { XCTFail("concurrent switch admitted"); return }
        }
        host.revoke(now: 0) { result in
            guard case .failure(.closing) = result else { XCTFail("concurrent revocation admitted"); return }
        }
        await fulfillment(of: [done], timeout: 5)
        try await close(host)
    }

    func testScopeRejectsOtherHostOldDocumentAndDisposedView() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view)
        let other = NativeDocumentCoordinator(editor: view); let oldScope = host.scope
        XCTAssertFalse(other.deliver(ifCurrent: oldScope) { _ in XCTFail("cross-host scope accepted") })
        _ = try await change(host, next)
        XCTAssertFalse(host.deliver(ifCurrent: oldScope) { _ in XCTFail("old document callback accepted") })
        XCTAssertTrue(host.deliver(ifCurrent: host.scope) { XCTAssertEqual($0.textView.string, "new") })
        let currentScope = host.scope; try await close(host)
        XCTAssertFalse(host.deliver(ifCurrent: currentScope) { _ in XCTFail("disposed callback accepted") })
        XCTAssertEqual(host.phase, .closed)
    }

    func testSwitchCancelsProvisionalInputAndLateOldReplacement() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view)
        let captured = try await view.composition.captureReplacement(range: NSRange(location: 1, length: 2))
        view.textView.setMarkedText("draft", selectedRange: NSRange(location: 1, length: 0),
                                    replacementRange: NSRange(location: 1, length: 2))
        let replacement = try await change(host, next)
        view.composition.replace(captured, with: "late")
        view.textView.insertText("late", replacementRange: NSRange(location: 0, length: 0))
        XCTAssertEqual(replacement.textView.string, "new"); XCTAssertTrue(view.isDisposed)
        let restored = try await open(old, create: false); let state = try await read(restored)
        XCTAssertEqual(state.nodes[0].text, "A🦀B")
        try await close(host); await dispose(restored)
    }

    func testRecoveryRequiredSwitchKeepsOldSalvageAndAllowsRepairRetry() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view); let oldScope = host.scope
        try sql(old, "CREATE TRIGGER reject_append BEFORE INSERT ON journal BEGIN SELECT RAISE(FAIL, 'native-switch-test'); END;")
        do { try await edit(view, "recovery"); XCTFail("fault did not reject append") } catch NativeSessionFailure.native(_) {}
        do { _ = try await change(host, next); XCTFail("recovery-required document closed") }
        catch NativeSessionFailure.native(.RecoveryRequired) {}
        XCTAssertTrue(host.editor === view); XCTAssertFalse(view.isDisposed); XCTAssertEqual(host.phase, .ready)
        XCTAssertFalse(host.deliver(ifCurrent: oldScope) { _ in XCTFail("old scope survived close attempt") })
        guard case let .recovery(export) = try await send(view, .recoveryExport) else { throw Unexpected() }
        XCTAssertFalse(export.locallyCommitted); XCTAssertNotNil(export.unjournaledUpdate)
        try sql(old, "DROP TRIGGER reject_append;")
        _ = try await send(view, .recover); let saved = try await read(view)
        XCTAssertEqual(saved.nodes[0].text, "ArecoveryB"); XCTAssertTrue(saved.locallyCommitted)
        _ = try await change(host, next, create: false)
        let restored = try await open(old, create: false); let after = try await read(restored)
        XCTAssertEqual(after.nodes, saved.nodes); XCTAssertEqual(after.pendingUpload, saved.pendingUpload)
        try await close(host); await dispose(restored)
    }

    func testAcceptedQueuedEditSettlesBeforeSwitchAndCloseCallback() async throws {
        let (root, old, next) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = try await open(old); let host = NativeDocumentCoordinator(editor: view); let before = try await read(view)
        let accepted = expectation(description: "accepted edit"); let order = Order()
        try view.session.submit(.nativeEdit(revision: before.revision!, edits: [NativeSessionEdit(
            node: before.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: "accepted")], now: 0)) { result in
                if case .failure = result { XCTFail("admitted edit failed") }
                order.values.append("edit"); accepted.fulfill()
            }
        let changed = expectation(description: "switched")
        host.switchDocument(options: next, initial: [NativeSessionSeed(kind: "block", text: "next")], now: 0) { result in
            if case .failure = result { XCTFail("switch failed") }
            order.values.append("switch"); changed.fulfill()
        }
        await fulfillment(of: [accepted, changed], timeout: 5)
        XCTAssertEqual(order.values, ["edit", "switch"])
        let restored = try await open(old, create: false); let after = try await read(restored)
        XCTAssertEqual(after.nodes[0].text, "AacceptedB"); XCTAssertTrue(after.locallyCommitted)
        try await close(host); await dispose(restored)
    }
}

@MainActor
private final class Order { var values: [String] = [] }
