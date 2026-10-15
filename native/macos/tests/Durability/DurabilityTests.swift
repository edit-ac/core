import AppKit
import XCTest
@testable import EditacMacOS

private struct Unexpected: Error {}

@MainActor
final class DurabilityTests: XCTestCase {
    private func fixture() throws -> (URL, NativeSessionOptions) {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editac-durability-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return (root, NativeSessionOptions(path: root.appendingPathComponent("document.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil))
    }
    private func open(_ view: NativeEditorView, _ options: NativeSessionOptions, create: Bool = true) async throws -> NativeSessionRead {
        let response: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            do { try view.session.open(options: options,
                initial: create ? [NativeSessionSeed(kind: "block", text: "A🦀B")] : nil, now: 0) {
                    c.resume(with: $0.mapError { $0 as Error })
                }
            } catch { c.resume(throwing: error) }
        }
        guard case let .snapshot(read) = response else { throw Unexpected() }
        return read
    }
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { c in
            do { try view.session.submit(request) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }
    private func read(_ view: NativeEditorView, now: UInt64 = 0) async throws -> NativeSessionRead {
        guard case let .snapshot(read) = try await send(view, .read(now: now)) else { throw Unexpected() }
        return read
    }
    private func edit(_ view: NativeEditorView, _ before: NativeSessionRead, text: String = "offline") async throws {
        _ = try await send(view, .nativeEdit(revision: before.revision!, edits: [NativeSessionEdit(
            node: before.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: text)], now: 0))
    }
    private func close(_ view: NativeEditorView) async throws {
        try await withCheckedThrowingContinuation { c in view.storage.close { c.resume(with: $0.mapError { $0 as Error }) } }
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
    private func recover(_ view: NativeEditorView) async throws {
        let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
            do { try view.storage.recover { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }

    func testActualNativeInputAcknowledgmentAndOfflineReopenWithoutAccount() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let chrome = NSView(frame: view.frame)
        view.frame = NSRect(x: 0, y: 24, width: 500, height: 276)
        view.storage.statusLabel.frame = NSRect(x: 4, y: 2, width: 492, height: 20)
        chrome.addSubview(view); chrome.addSubview(view.storage.statusLabel)
        window.contentView = chrome
        defer { window.contentView = nil; window.close() }
        XCTAssertTrue(view.storage.statusLabel.window === window)
        XCTAssertFalse(view.frame.intersects(view.storage.statusLabel.frame))
        let before = try await open(view, options)
        view.input.now = { 0 }
        let result: Result<Void, NativeInputFailure> = await withCheckedContinuation { c in
            view.input.onResult = { result in view.input.onResult = nil; c.resume(returning: result) }
            view.textView.insertText("offline", replacementRange: NSRange(location: 1, length: 2))
        }
        try result.get()
        let status = view.storage.status
        XCTAssertEqual(status.phase, .committed)
        let receipt = try XCTUnwrap(status.receipt)
        XCTAssertEqual(receipt.durability, .processCrash); XCTAssertEqual(receipt.checksum.count, 32)
        XCTAssertEqual(receipt.sequence, 1)
        XCTAssertEqual(status.snapshot?.pendingUpload, before.pendingUpload + 1)
        XCTAssertEqual(view.storage.statusLabel.stringValue, "Saved locally — upload pending")
        XCTAssertEqual(view.textView.string, "AofflineB")
        let saved = try await read(view)
        try await close(view)
        let restored = NativeEditorView(frame: .zero)
        let after = try await open(restored, options, create: false)
        XCTAssertEqual(after.nodes, saved.nodes); XCTAssertEqual(after.revision, saved.revision)
        XCTAssertTrue(after.locallyCommitted); XCTAssertEqual(after.localDurability, .processCrash)
        XCTAssertEqual(after.pendingUpload, saved.pendingUpload)
        XCTAssertNil(restored.storage.status.receipt, "restore must not fabricate a new commit receipt")
        XCTAssertEqual(restored.textView.string, "AofflineB")
        try await close(restored)
    }

    func testCloseWaitsForAcceptedCommitAndStopsAdmission() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); let before = try await open(view, options)
        let gate = DispatchSemaphore(value: 0); view.session.enqueueBarrier { gate.wait() }
        var committed = false
        try view.session.submit(.nativeEdit(revision: before.revision!, edits: [NativeSessionEdit(
            node: before.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: "queued")], now: 0)) {
                if case .success = $0 { committed = true } else { XCTFail("accepted commit failed") }
            }
        XCTAssertEqual(view.storage.status.phase, .pending)
        let observe = view.session.onStorageStatus
        var reentrantAdmissionChecked = false
        view.session.onStorageStatus = { [weak view] status in
            observe?(status)
            guard let view, view.storage.isClosing, !reentrantAdmissionChecked else { return }
            reentrantAdmissionChecked = true
            do { try view.session.submit(.read(now: 0)); XCTFail("observer bypassed close admission") }
            catch NativeSessionFailure.closing {} catch { XCTFail("\(error)") }
        }
        let result: Result<Void, NativeSessionFailure> = await withCheckedContinuation { c in
            view.storage.close { c.resume(returning: $0) }
            do { try view.session.submit(.read(now: 0)); XCTFail("close admitted a request") }
            catch NativeSessionFailure.closing {} catch { XCTFail("\(error)") }
            gate.signal()
        }
        try result.get(); XCTAssertTrue(committed); XCTAssertTrue(view.isDisposed)
        XCTAssertTrue(reentrantAdmissionChecked)
        let restored = NativeEditorView(frame: .zero); let after = try await open(restored, options, create: false)
        XCTAssertEqual(after.nodes[0].text, "AqueuedB"); XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
        try await close(restored)
    }

    func testSQLiteAppendFailureRetainsExactRecoveryAcrossRejectedCloseAndUndo() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); let before = try await open(view, options)
        try sql(options, "CREATE TRIGGER reject_append BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'deterministic append failure'); END;")
        do { try await edit(view, before); XCTFail("SQLite failure acknowledged") }
        catch NativeSessionFailure.native(.Store(_)) {} catch { XCTFail("unexpected \(error)") }
        XCTAssertEqual(view.storage.status.phase, .recoveryRequired)
        XCTAssertNil(view.storage.status.receipt); XCTAssertFalse(view.textView.isEditable)
        XCTAssertFalse(try XCTUnwrap(view.storage.status.snapshot).locallyCommitted)
        XCTAssertNil(view.storage.status.snapshot?.revision)
        guard case let .recovery(salvage) = try await send(view, .recoveryExport) else { throw Unexpected() }
        XCTAssertFalse(salvage.locallyCommitted); XCTAssertNotNil(salvage.unjournaledUpdate)
        do { try await close(view); XCTFail("unsaved document closed") }
        catch NativeSessionFailure.native(.RecoveryRequired) {} catch { XCTFail("\(error)") }
        XCTAssertFalse(view.isDisposed)
        do { try await recover(view); XCTFail("unrepaired store recovered") } catch NativeSessionFailure.native(_) {}
        try sql(options, "DROP TRIGGER reject_append;")
        try await recover(view)
        let recovered = try await read(view)
        XCTAssertTrue(recovered.locallyCommitted); XCTAssertFalse(recovered.recoveryRequired)
        XCTAssertEqual(recovered.nodes[0].text, "AofflineB")
        XCTAssertEqual(recovered.pendingUpload, before.pendingUpload + 1)
        XCTAssertNil(view.projectionFailure); XCTAssertEqual(view.textView.string, "AofflineB")
        try await recover(view)
        let again = try await read(view); XCTAssertEqual(again.pendingUpload, recovered.pendingUpload)
        _ = try await send(view, .undo(revision: recovered.revision!, now: 1))
        let undone = try await read(view); XCTAssertEqual(undone.nodes, before.nodes)
        try await close(view)
        let restored = NativeEditorView(frame: .zero); let after = try await open(restored, options, create: false)
        XCTAssertEqual(after.nodes, before.nodes); XCTAssertEqual(after.pendingUpload, before.pendingUpload + 2)
        try await close(restored)
    }

    func testCorruptOpenPreservesBytesAndDoesNotInitializeFallback() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data("not a SQLite database".utf8); try bytes.write(to: URL(fileURLWithPath: options.path))
        let view = NativeEditorView(frame: .zero)
        do { _ = try await open(view, options, create: false); XCTFail("corrupt restore opened") } catch NativeSessionFailure.native(_) {}
        XCTAssertEqual(view.storage.status.phase, .error)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: options.path)), bytes)
        do { _ = try await open(view, options); XCTFail("corrupt store overwritten") } catch NativeSessionFailure.native(_) {}
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: options.path)), bytes)
        await dispose(view)
    }

    func testReadOnlyRestoreAndClosePreservesDurableContent() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); let before = try await open(view, options)
        try await edit(view, before); let saved = try await read(view); try await close(view)
        var readonly = options; readonly.writable = false
        let restored = NativeEditorView(frame: .zero); let after = try await open(restored, readonly, create: false)
        XCTAssertFalse(after.canApply); XCTAssertEqual(after.nodes, saved.nodes)
        do { try await edit(restored, after); XCTFail("readonly mutated") } catch NativeSessionFailure.native(_) {}
        let unchanged = try await read(restored)
        XCTAssertEqual(unchanged.nodes, saved.nodes)
        try await close(restored)
    }

    func testBackgroundNotificationUsesHostClockAndDoesNotClaimSynchronization() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); _ = try await open(view, options)
        _ = try await send(view, .permission(writable: true, expiresAt: 10))
        let center = NotificationCenter(); let window = NSWindow()
        window.isReleasedWhenClosed = false
        view.storage.bind(window: window, notifications: center, now: { 10 })
        center.post(name: NSApplication.didResignActiveNotification, object: nil)
        let after = try await read(view, now: 10)
        XCTAssertFalse(after.canApply); XCTAssertFalse(view.textView.isEditable)
        XCTAssertEqual(view.storage.status.phase, .committed)
        XCTAssertFalse(view.storage.statusLabel.stringValue.contains("synchronized"))
        try await close(view); window.close()
    }

    func testWindowCloseNotificationReleasesActualSessionAfterQueuedWork() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); let before = try await open(view, options)
        try await edit(view, before)
        let window = NSWindow(); window.isReleasedWhenClosed = false
        view.storage.bind(window: window, now: { 0 })
        let result: Result<Void, NativeSessionFailure> = await withCheckedContinuation { c in
            view.storage.onWindowClose = { result in view.storage.onWindowClose = nil; c.resume(returning: result) }
            window.close()
        }
        try result.get()
        XCTAssertTrue(view.isDisposed)
        let restored = NativeEditorView(frame: .zero); let after = try await open(restored, options, create: false)
        XCTAssertEqual(after.nodes[0].text, "AofflineB"); try await close(restored)
    }

    func testRebindingRemovesOldWindowAndDisposedNotificationsDoNotDeliver() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); _ = try await open(view, options)
        let a = NSWindow(); let b = NSWindow(); a.isReleasedWhenClosed = false; b.isReleasedWhenClosed = false
        let center = NotificationCenter()
        view.storage.bind(window: a, notifications: center, now: { 0 })
        view.storage.bind(window: b, notifications: center, now: { 0 })
        center.post(name: NSWindow.willCloseNotification, object: a)
        _ = try await read(view); XCTAssertFalse(view.isDisposed)
        try await close(view); let deliveries = view.sessionDeliveryCount
        center.post(name: NSWindow.willCloseNotification, object: b)
        center.post(name: NSApplication.didResignActiveNotification, object: nil)
        XCTAssertEqual(view.sessionDeliveryCount, deliveries)
        a.close(); b.close()
    }

    func testCancelledQueuedCommitDoesNotProduceSaveReceipt() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); let before = try await open(view, options)
        let gate = DispatchSemaphore(value: 0); view.session.enqueueBarrier { gate.wait() }
        let result: Result<NativeSessionResponse, NativeSessionFailure> = await withCheckedContinuation { c in
            do {
                let operation = try view.session.submit(.nativeEdit(revision: before.revision!, edits: [NativeSessionEdit(
                    node: before.nodes[0].id, fromUtf16: 1, toUtf16: 3, text: "cancelled")], now: 0)) { c.resume(returning: $0) }
                XCTAssertTrue(operation.cancel()); gate.signal()
            } catch { gate.signal(); c.resume(returning: .failure(.unexpected("\(error)"))) }
        }
        if case .failure(.cancelled) = result {} else { XCTFail("cancel did not prevent work") }
        XCTAssertEqual(view.storage.status.phase, .error); XCTAssertNil(view.storage.status.receipt)
        let after = try await read(view); XCTAssertEqual(after.nodes, before.nodes); XCTAssertEqual(after.pendingUpload, before.pendingUpload)
        try await close(view)
    }

    func testRejectedCommandRetainsPriorReceiptWithoutFalseAcknowledgment() async throws {
        let (root, options) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let view = NativeEditorView(frame: .zero); let before = try await open(view, options)
        try await edit(view, before)
        let receipt = try XCTUnwrap(view.storage.status.receipt)
        do { try await edit(view, before, text: "stale"); XCTFail("stale edit accepted") } catch NativeSessionFailure.native(_) {}
        XCTAssertEqual(view.storage.status.phase, .error)
        XCTAssertEqual(view.storage.status.receipt, receipt)
        XCTAssertEqual(view.storage.statusLabel.stringValue, "Local operation failed")
        let after = try await read(view); XCTAssertEqual(after.nodes[0].text, "AofflineB")
        XCTAssertEqual(after.pendingUpload, before.pendingUpload + 1)
        try await close(view)
    }
}
