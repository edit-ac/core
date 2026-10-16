import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureFailure: Error {}

/// Prepared authenticated host/transport. Only exact fixture envelopes explicitly
/// admitted by the test may cross the native boundary. No network or credentials.
@MainActor
private final class FixtureTransport: NativeCollaborationTransport {
    var authorized = true
    var failSend = false
    var allowed: Set<NativeSessionPeerUpdate> = []
    var allowedPresence: Set<NativeHostFrame> = []
    var allowedReceipts: Set<NativeHostReceipt> = []
    var sent: [NativeSessionPeerUpdate] = []
    var presence: [NativeHostFrame] = []
    var frameCount = 0
    func authorize(_ options: NativeHostTransportOptions) throws {
        guard authorized else { throw FixtureFailure() }
    }
    func admit(_ update: NativeSessionPeerUpdate) throws {
        guard authorized, allowed.contains(update) else { throw FixtureFailure() }
    }
    func admitPresence(_ frame: NativeHostFrame) throws {
        guard authorized, allowedPresence.contains(frame) else { throw FixtureFailure() }
    }
    func admitReceipt(_ receipt: NativeHostReceipt) throws {
        guard authorized, allowedReceipts.contains(receipt) else { throw FixtureFailure() }
    }
    func send(frames: [NativeHostFrame], updates: [NativeSessionPeerUpdate]) throws {
        guard !failSend else { throw FixtureFailure() }
        for frame in frames {
            guard let entry = updates.first(where: {
                $0.identityJson == frame.identityJson && frame.bytes.suffix($0.bytes.count) == $0.bytes
            }) else { throw FixtureFailure() }
            sent.append(entry)
        }
        frameCount += frames.count
    }
    func sendPresence(_ frames: [NativeHostFrame]) throws { presence += frames }
}

@MainActor
final class CollaborationTests: XCTestCase {
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await call { done in
            do { try view.session.submit(request, completion: done) } catch { done(.failure(.unexpected("\(error)"))) }
        }
    }
    private func call(_ body: (@escaping NativeSessionExecutor.Completion) -> Void) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { c in body { c.resume(with: $0.mapError { $0 as Error }) } }
    }
    private func read(_ view: NativeEditorView) async throws -> NativeSessionRead {
        guard case let .snapshot(value) = try await send(view, .read(now: 0)) else { throw FixtureFailure() }
        return value
    }
    private func pending(_ view: NativeEditorView) async throws -> [NativeSessionPeerUpdate] {
        guard case let .peerUpdates(value) = try await send(view, .pendingUpdates) else { throw FixtureFailure() }
        return value
    }
    private func firstPending(_ view: NativeEditorView) async throws -> NativeSessionPeerUpdate {
        let entries = try await pending(view)
        return try XCTUnwrap(entries.first)
    }
    private func edit(_ view: NativeEditorView, _ text: String, from: UInt32 = 0, to: UInt32 = 0) async throws {
        let before = try await read(view)
        _ = try await send(view, .nativeEdit(revision: before.revision!, edits: [NativeSessionEdit(
            node: before.nodes[0].id, fromUtf16: from, toUtf16: to, text: text)], now: 0))
    }
    private func receipt(_ entry: NativeSessionPeerUpdate) -> NativeHostReceipt {
        NativeHostReceipt(identityJson: entry.identityJson, writer: entry.writer, sequence: entry.sequence, checksum: entry.checksum)
    }
    private func connect(_ view: NativeEditorView, _ options: NativeHostTransportOptions, _ host: FixtureTransport,
                         now: UInt64 = 0) async throws -> NativeCollaborationScope {
        _ = try await call { view.collaboration.connect(options: options, transport: host, now: now, completion: $0) }
        return try XCTUnwrap(view.collaboration.scope)
    }
    private func fixture(_ body: @MainActor (NativeEditorView, NativeEditorView, NativeHostTransportOptions,
                                 FixtureTransport, FixtureTransport, NativeSessionOptions) async throws -> Void) async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editac-collaboration-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = NativeSessionOptions(path: root.appendingPathComponent("seed.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil)
        let seed = try NativeSession.createLocal(options: original, initial: [NativeSessionSeed(kind: "block", text: "A🦀B")])
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(seed.richSnapshot().snapshotJson.utf8)) as? [String: Any])
        let identity = String(decoding: try JSONSerialization.data(withJSONObject: XCTUnwrap(json["identity"]), options: [.sortedKeys]), as: UTF8.self)
        try seed.dispose()
        var leftOptions = original; leftOptions.path = root.appendingPathComponent("left.sqlite").path
        var rightOptions = original; rightOptions.path = root.appendingPathComponent("right.sqlite").path
        try FileManager.default.copyItem(atPath: original.path, toPath: leftOptions.path)
        try FileManager.default.copyItem(atPath: original.path, toPath: rightOptions.path)
        XCTAssertNotEqual(leftOptions.path, rightOptions.path)
        let left = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let right = NativeEditorView(frame: left.frame)
        let windows = [left, right].map { view in
            let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let chrome = NSView(frame: view.frame)
            view.frame = NSRect(x: 0, y: 24, width: 500, height: 276)
            view.collaboration.statusLabel.frame = NSRect(x: 4, y: 2, width: 492, height: 20)
            chrome.addSubview(view); chrome.addSubview(view.collaboration.statusLabel)
            window.contentView = chrome
            return window
        }
        defer { for window in windows { window.contentView = nil; window.close() } }
        for (view, options) in [(left, leftOptions), (right, rightOptions)] {
            _ = try await call { done in
                do { try view.session.open(options: options, now: 0, completion: done) }
                catch { done(.failure(.unexpected("\(error)"))) }
            }
            view.composition.now = { 0 }
        }
        let options = NativeHostTransportOptions(identityJson: identity, expiresAt: 100_000, durableReceipts: true,
            maxFrameBytes: 1_048_576, maxQueueBytes: 2_097_152, maxQueueFrames: 32)
        let lh = FixtureTransport(), rh = FixtureTransport()
        do {
            try await body(left, right, options, lh, rh, rightOptions)
        } catch {
            await withCheckedContinuation { c in left.dispose { c.resume() } }
            await withCheckedContinuation { c in right.dispose { c.resume() } }
            throw error
        }
        await withCheckedContinuation { c in left.dispose { c.resume() } }
        await withCheckedContinuation { c in right.dispose { c.resume() } }
    }
    private func receive(_ entry: NativeSessionPeerUpdate, _ view: NativeEditorView, _ host: FixtureTransport,
                         _ scope: NativeCollaborationScope, reserve: Bool = true, now: UInt64 = 0) async throws {
        host.allowed.insert(entry)
        if reserve { _ = try await send(view, .reservePeerWriter(entry.writer)) }
        _ = try await call { view.collaboration.receive(entry, in: scope, now: now, completion: $0) }
    }
    private func denied(_ body: () async throws -> Void) async {
        do { try await body(); XCTFail("Expected rejection") } catch {}
    }

    func testSeparateStoresReconnectConvergenceExactReceiptsAndHistory() async throws {
        try await fixture { l, r, options, lh, rh, _ in
            let ls = try await self.connect(l, options, lh), rs = try await self.connect(r, options, rh)
            try await self.edit(l, "local "); try await self.edit(r, "remote ")
            let le = try await self.firstPending(l), re = try await self.firstPending(r)
            _ = try await self.call { r.collaboration.flush(rs, now: 0, completion: $0) }
            XCTAssertEqual(rh.sent, [re]); XCTAssertEqual(rh.frameCount, 1)
            let unacknowledged = try await self.pending(r); XCTAssertEqual(unacknowledged.count, 1)
            _ = try await self.call { r.collaboration.disconnect(completion: $0) }
            let replacement = try await self.connect(r, options, rh, now: 1)
            XCTAssertNotEqual(rs, replacement)
            await self.denied { _ = try await self.call { r.collaboration.disconnect(in: rs, completion: $0) } }
            XCTAssertEqual(r.collaboration.scope, replacement)
            await self.denied { _ = try await self.call { r.collaboration.flush(rs, now: 1, completion: $0) } }
            _ = try await self.call { r.collaboration.flush(replacement, now: 1, completion: $0) }
            XCTAssertEqual(rh.sent, [re, re])
            try await self.receive(re, l, lh, ls)
            let actual = try XCTUnwrap(l.storage.status.receipt)
            XCTAssertEqual(actual.writer, re.writer); XCTAssertEqual(actual.sequence, re.sequence)
            XCTAssertEqual(actual.checksum, re.checksum); XCTAssertEqual(actual.durability, .processCrash)
            try await self.receive(le, r, rh, replacement)
            let lr = try await self.read(l), rr = try await self.read(r)
            XCTAssertEqual(lr.nodes, rr.nodes); XCTAssertEqual(l.textView.string, r.textView.string)
            let ack = self.receipt(re); rh.allowedReceipts.insert(ack)
            let response = try await self.call { r.collaboration.accept(ack, in: replacement, now: 1, completion: $0) }
            guard case .hostReceipt(.remoteCommitted) = response else { return XCTFail("Exact application receipt missing") }
            let remaining = try await self.pending(r)
            XCTAssertFalse(remaining.contains(re)); XCTAssertTrue(remaining.contains(le))
            _ = try await self.send(l, .undo(revision: lr.revision!, now: 0))
            let undo = try await self.read(l)
            XCTAssertEqual(undo.nodes[0].text, "remote A🦀B")
            XCTAssertEqual(l.textView.string, "remote A🦀B")
            _ = try await self.send(l, .redo(revision: undo.revision!, now: 0))
            _ = try await self.read(l)
            XCTAssertEqual(l.textView.string, r.textView.string)
        }
    }

    func testSendFailureKeepsDurableOutboxForReconnect() async throws {
        try await fixture { l, _, options, lh, _, _ in
            let scope = try await self.connect(l, options, lh)
            try await self.edit(l, "saved")
            lh.failSend = true
            await self.denied { _ = try await self.call { l.collaboration.flush(scope, now: 0, completion: $0) } }
            let pending = try await self.pending(l); XCTAssertEqual(pending.count, 1)
            lh.failSend = false
            _ = try await self.call { l.collaboration.disconnect(completion: $0) }
            let fresh = try await self.connect(l, options, lh)
            _ = try await self.call { l.collaboration.flush(fresh, now: 0, completion: $0) }
            XCTAssertEqual(lh.sent, pending)
        }
    }

    func testRemoteSelectionUsesSharedAnchorsWithoutChangingLocalSelectionOrReceipts() async throws {
        try await fixture { l, r, options, lh, rh, _ in
            let ls = try await self.connect(l, options, lh), rs = try await self.connect(r, options, rh)
            l.textView.setSelectedRange(NSRange(location: 0, length: 0))
            r.textView.setSelectedRange(NSRange(location: 1, length: 2))
            let before = try await self.read(l)
            _ = try await self.call { r.collaboration.publishSelection(in: rs, now: 100, completion: $0) }
            let frame = try XCTUnwrap(rh.presence.first); lh.allowedPresence.insert(frame)
            _ = try await self.call { l.collaboration.receivePresence(frame, in: ls, now: 100, completion: $0) }
            XCTAssertEqual(l.collaboration.peers.count, 1)
            XCTAssertEqual(Array(l.collaboration.remoteRanges.values), [NSRange(location: 1, length: 2)])
            XCTAssertEqual(l.textView.selectedRange(), NSRange(location: 0, length: 0))
            XCTAssertTrue(l.collaboration.statusLabel.stringValue.contains("1 remote"))
            XCTAssertNotNil(l.collaboration.statusLabel.window)
            XCTAssertFalse(l.frame.intersects(l.collaboration.statusLabel.frame))
            let after = try await self.read(l)
            XCTAssertEqual(before.revision, after.revision); XCTAssertEqual(before.pendingUpload, after.pendingUpload)
            _ = try await self.call { l.collaboration.refresh(now: 30_101, completion: $0) }
            XCTAssertTrue(l.collaboration.peers.isEmpty); XCTAssertTrue(l.collaboration.remoteRanges.isEmpty)
        }
    }

    func testReadOnlyLocalPermissionStillAllowsAuthorizedRemoteInput() async throws {
        try await fixture { l, r, options, lh, _, _ in
            let scope = try await self.connect(l, options, lh)
            _ = try await self.send(l, .commandPermission(writable: false, expiresAt: nil, now: 0))
            try await self.edit(r, "remote")
            let entry = try await self.firstPending(r)
            try await self.receive(entry, l, lh, scope)
            XCTAssertEqual(l.textView.string, r.textView.string)
            XCTAssertFalse(l.sessionSnapshot!.canApply); XCTAssertFalse(l.textView.isEditable)
        }
    }

    func testExclusiveLeaseExpiryRejectsLateIngressAndPresence() async throws {
        try await fixture { l, r, base, lh, _, _ in
            var options = base; options.expiresAt = 10
            let scope = try await self.connect(l, options, lh)
            try await self.edit(r, "late")
            let entry = try await self.firstPending(r)
            lh.allowed.insert(entry); _ = try await self.send(l, .reservePeerWriter(entry.writer))
            let before = try await self.read(l)
            await self.denied { _ = try await self.call { l.collaboration.receive(entry, in: scope, now: 10, completion: $0) } }
            await self.denied { _ = try await self.call { l.collaboration.publishSelection(in: scope, now: 10, completion: $0) } }
            let after = try await self.read(l); XCTAssertEqual(before.revision, after.revision)
            XCTAssertTrue(l.collaboration.remoteRanges.isEmpty)
        }
    }

    func testHostAuthorizationAndEnvelopeDenialPrecedeMutation() async throws {
        try await fixture { l, r, options, lh, _, _ in
            lh.authorized = false
            await self.denied { _ = try await self.connect(l, options, lh) }
            XCTAssertNil(l.collaboration.scope)
            lh.authorized = true
            let scope = try await self.connect(l, options, lh)
            try await self.edit(r, "untrusted")
            let entry = try await self.firstPending(r)
            let before = try await self.read(l)
            await self.denied { _ = try await self.call { l.collaboration.receive(entry, in: scope, now: 0, completion: $0) } }
            let after = try await self.read(l); XCTAssertEqual(before.revision, after.revision)
            XCTAssertFalse(after.recoveryRequired)
        }
    }

    func testRevocationDetachesConnectionCancelsInputAndPreservesReceipt() async throws {
        try await fixture { l, r, options, lh, _, _ in
            let scope = try await self.connect(l, options, lh)
            try await self.edit(l, "durable")
            let receipt = l.storage.status.receipt
            l.textView.setSelectedRange(NSRange(location: 0, length: 0))
            l.textView.setMarkedText("temporary", selectedRange: NSRange(location: 9, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
            _ = try await self.send(l, .read(now: 0)); XCTAssertTrue(l.composition.isActive)
            let host = NativeDocumentCoordinator(editor: l)
            _ = try await self.call { host.revoke(now: 0, completion: $0) }
            _ = try await self.send(l, .read(now: 0))
            XCTAssertNil(l.collaboration.scope); XCTAssertFalse(l.composition.isActive)
            XCTAssertEqual(l.storage.status.receipt, receipt); XCTAssertFalse(l.sessionSnapshot!.canApply)
            try await self.edit(r, "late")
            let entry = try await self.firstPending(r)
            await self.denied { _ = try await self.call { l.collaboration.receive(entry, in: scope, now: 0, completion: $0) } }
            XCTAssertFalse(l.textView.string.contains("temporary"))
        }
    }

    func testDocumentSwitchDisposesOldConnectionAndRejectsLateCallbacks() async throws {
        try await fixture { l, r, options, lh, _, rightOptions in
            let scope = try await self.connect(l, options, lh)
            let host = NativeDocumentCoordinator(editor: l)
            var next = rightOptions; next.path += "-next"; next.documentId = UUID().uuidString.lowercased()
            let _: Void = try await withCheckedThrowingContinuation { c in
                host.switchDocument(options: next, initial: [NativeSessionSeed(kind: "block", text: "replacement")], now: 0) {
                    c.resume(with: $0.map { _ in () }.mapError { $0 as Error })
                }
            }
            let replacement = host.editor
            XCTAssertTrue(l.isDisposed); XCTAssertNil(l.collaboration.scope)
            try await self.edit(r, "old")
            let entry = try await self.firstPending(r)
            await self.denied { _ = try await self.call { l.collaboration.receive(entry, in: scope, now: 0, completion: $0) } }
            XCTAssertEqual(replacement.textView.string, "replacement")
            await withCheckedContinuation { c in replacement.dispose { c.resume() } }
        }
    }

    func testRemoteCompositionOverlapCancelsProvisionalAndPreservesRemoteThroughUndo() async throws {
        try await fixture { l, r, options, lh, rh, _ in
            let ls = try await self.connect(l, options, lh), rs = try await self.connect(r, options, rh)
            l.textView.setSelectedRange(NSRange(location: 1, length: 2))
            l.textView.setMarkedText("provisional", selectedRange: NSRange(location: 11, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
            _ = try await self.send(l, .read(now: 0)); XCTAssertTrue(l.composition.isActive)
            await self.denied { _ = try await self.call { l.collaboration.publishSelection(in: ls, now: 100, completion: $0) } }
            XCTAssertTrue(lh.presence.isEmpty)
            try await self.edit(r, "REMOTE", from: 1, to: 3)
            let entry = try await self.firstPending(r)
            try await self.receive(entry, l, lh, ls)
            _ = try await self.send(l, .read(now: 0))
            XCTAssertFalse(l.composition.isActive); XCTAssertEqual(l.textView.string, "AREMOTEB")
            XCTAssertEqual(l.composition.acceptedCount, 0)
            l.textView.setSelectedRange(NSRange(location: 0, length: 0))
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                l.composition.onResult = { result in
                    l.composition.onResult = nil
                    c.resume(with: result.mapError { $0 as Error })
                }
                l.textView.setMarkedText("local ", selectedRange: NSRange(location: 6, length: 0),
                    replacementRange: NSRange(location: NSNotFound, length: 0))
                l.textView.insertText("local ", replacementRange: NSRange(location: NSNotFound, length: 0))
            }
            XCTAssertEqual(l.composition.acceptedCount, 1)
            let before = try await self.read(l)
            _ = try await self.send(l, .undo(revision: before.revision!, now: 0))
            let undone = try await self.read(l)
            XCTAssertEqual(undone.nodes[0].text, "AREMOTEB")
            XCTAssertEqual(l.textView.string, "AREMOTEB")
            _ = try await self.call { r.collaboration.flush(rs, now: 0, completion: $0) }
            XCTAssertFalse(rh.sent.contains(where: { String(decoding: $0.bytes, as: UTF8.self).contains("provisional") }))
        }
    }

    func testCancelledQueuedHostIngressDoesNotMutateOrMintReceipt() async throws {
        try await fixture { l, r, options, lh, _, _ in
            let scope = try await self.connect(l, options, lh)
            try await self.edit(r, "cancel")
            let entry = try await self.firstPending(r)
            _ = try await self.send(l, .reservePeerWriter(entry.writer))
            let before = try await self.read(l)
            let gate = DispatchSemaphore(value: 0)
            l.session.enqueueBarrier { gate.wait() }
            let result = expectation(description: "cancelled ingress")
            let operation = try l.session.receiveHostPeer(token: scope.token, update: entry, now: 0, admitting: { _ in }) { response in
                guard case .failure(.cancelled) = response else { XCTFail("Cancelled work accepted"); result.fulfill(); return }
                result.fulfill()
            }
            XCTAssertTrue(operation.cancel()); gate.signal()
            await fulfillment(of: [result], timeout: 5)
            let after = try await self.read(l); XCTAssertEqual(before.revision, after.revision)
            XCTAssertNil(l.storage.status.receipt)
        }
    }

    func testReceiptRequiresAuthenticatedExactNegotiatedApplicationIdentity() async throws {
        try await fixture { l, _, base, lh, _, _ in
            var options = base; options.durableReceipts = false
            let scope = try await self.connect(l, options, lh)
            try await self.edit(l, "pending")
            let entry = try await self.firstPending(l), ack = self.receipt(entry)
            await self.denied { _ = try await self.call { l.collaboration.accept(ack, in: scope, now: 0, completion: $0) } }
            lh.allowedReceipts.insert(ack)
            let result = try await self.call { l.collaboration.accept(ack, in: scope, now: 0, completion: $0) }
            guard case .hostReceipt(.capabilityUnavailable) = result else { return XCTFail("Unnegotiated receipt accepted") }
            let pending = try await self.pending(l); XCTAssertEqual(pending.count, 1)
        }
    }

    func testDisconnectWhileAttachQueuedCannotLeaveOrReviveConnection() async throws {
        try await fixture { l, _, options, lh, _, _ in
            let gate = DispatchSemaphore(value: 0)
            l.session.enqueueBarrier { gate.wait() }
            l.collaboration.connect(options: options, transport: lh, now: 0)
            l.collaboration.disconnect()
            gate.signal()
            _ = try await self.send(l, .read(now: 0))
            XCTAssertNil(l.collaboration.scope); XCTAssertEqual(l.collaboration.state, .disconnected)
            let fresh = try await self.connect(l, options, lh)
            XCTAssertEqual(l.collaboration.scope, fresh)
        }
    }
    func testPagedBacklogLargerThanQueueWithoutDurableReceipts() async throws {
        try await fixture { l, r, base, lh, rh, _ in
            var options = base; options.maxQueueFrames = 1; options.durableReceipts = false
            let ls = try await self.connect(l, options, lh), rs = try await self.connect(r, options, rh)
            for text in ["one ", "two ", "three "] { try await self.edit(r, text) }
            let entries = try await self.pending(r); XCTAssertEqual(entries.count, 3)
            var cursor: NativeHostReceipt?
            for (index, entry) in entries.enumerated() {
                _ = try await self.call { r.collaboration.flush(rs, after: cursor, maxFrames: 1, now: 0, completion: $0) }
                XCTAssertEqual(rh.sent.last, entry)
                try await self.receive(entry, l, lh, ls, reserve: index == 0)
                cursor = self.receipt(entry)
            }
            XCTAssertEqual(l.textView.string, r.textView.string)
            let retained = try await self.pending(r); XCTAssertEqual(retained, entries)
            XCTAssertEqual(rh.frameCount, 3)
        }
    }

    func testPresenceRemapsAfterUnicodeEditAndRejectsPreviousConnection() async throws {
        try await fixture { l, r, options, lh, rh, _ in
            let ls = try await self.connect(l, options, lh), rs = try await self.connect(r, options, rh)
            r.textView.setSelectedRange(NSRange(location: 1, length: 2))
            _ = try await self.call { r.collaboration.publishSelection(in: rs, now: 100, completion: $0) }
            let frame = try XCTUnwrap(rh.presence.first); lh.allowedPresence.insert(frame)
            _ = try await self.call { l.collaboration.receivePresence(frame, in: ls, now: 100, completion: $0) }
            try await self.edit(l, "😀")
            _ = try await self.call { l.collaboration.refresh(now: 101, completion: $0) }
            XCTAssertEqual(Array(l.collaboration.remoteRanges.values), [NSRange(location: 3, length: 2)])
            let fresh = try await self.connect(l, options, lh, now: 101)
            XCTAssertNotEqual(fresh, ls); XCTAssertTrue(l.collaboration.peers.isEmpty)
            await self.denied { _ = try await self.call { l.collaboration.receivePresence(frame, in: ls, now: 102, completion: $0) } }
            XCTAssertTrue(l.collaboration.remoteRanges.isEmpty)
        }
    }

    func testRejectedRemoteEnvelopePreservesActiveComposition() async throws {
        try await fixture { l, r, options, lh, _, _ in
            let scope = try await self.connect(l, options, lh)
            l.textView.setSelectedRange(NSRange(location: 1, length: 2))
            l.textView.setMarkedText("temporary", selectedRange: NSRange(location: 9, length: 0),
                replacementRange: NSRange(location: NSNotFound, length: 0))
            _ = try await self.send(l, .read(now: 0))
            try await self.edit(r, "denied")
            let entry = try await self.firstPending(r)
            await self.denied { _ = try await self.call { l.collaboration.receive(entry, in: scope, now: 0, completion: $0) } }
            XCTAssertTrue(l.composition.isActive); XCTAssertTrue(l.textView.string.contains("temporary"))
            l.composition.cancel(); _ = try await self.send(l, .read(now: 0))
            XCTAssertEqual(l.textView.string, "A🦀B")
        }
    }

    func testOfflineReopenRetainsUnacknowledgedWorkAndRejectsDisposedScope() async throws {
        try await fixture { _, r, options, _, rh, rightOptions in
            let scope = try await self.connect(r, options, rh)
            try await self.edit(r, "saved ")
            let entries = try await self.pending(r)
            await withCheckedContinuation { c in r.dispose { c.resume() } }
            await self.denied { _ = try await self.call { r.collaboration.flush(scope, now: 0, completion: $0) } }
            let restored = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
            _ = try await self.call { done in
                do { try restored.session.open(options: rightOptions, now: 0, completion: done) }
                catch { done(.failure(.unexpected("\(error)"))) }
            }
            let pending = try await self.pending(restored); XCTAssertEqual(pending, entries)
            XCTAssertEqual(restored.textView.string, "saved A🦀B")
            let fresh = try await self.connect(restored, options, rh)
            _ = try await self.call { restored.collaboration.flush(fresh, now: 0, completion: $0) }
            XCTAssertEqual(rh.sent, entries)
            await withCheckedContinuation { c in restored.dispose { c.resume() } }
        }
    }

}
