import AppKit
import XCTest
@testable import EditacMacOS

private struct FixtureFailure: Error {}

/// The OS invokes these handlers off the main actor. The gate lets a test
/// release a real NSItemProvider callback after permission/disposal changes.
private final class ProviderGate: @unchecked Sendable {
    let provider = NSItemProvider()
    let started = XCTestExpectation(description: "OS requested provider bytes")
    private let lock = NSLock()
    private var callback: (@Sendable (Data?, (any Error)?) -> Void)?
    private(set) var progress: Progress?
    init(flavor: NativeClipboardFlavor = .plain) {
        provider.registerDataRepresentation(forTypeIdentifier: flavor.rawValue, visibility: .all) { [weak self] callback in
            guard let self else { return nil }
            let progress = Progress(totalUnitCount: 1)
            self.lock.lock(); self.callback = callback; self.progress = progress; self.lock.unlock()
            self.started.fulfill()
            return progress
        }
    }
    func deliver(_ data: Data?, error: Error? = nil) {
        lock.lock(); let callback = self.callback; lock.unlock()
        callback?(data, error)
    }
}

@MainActor
final class ClipboardTransportTests: XCTestCase {
    private func board(_ body: (NSPasteboard) throws -> Void) rethrows {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        try body(board)
    }
    private func offer(_ text: String = "A🦀B") throws -> NativeClipboardOffer {
        try NativeClipboardOffer([.plain: Data(text.utf8)])
    }
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { c in
            do { try view.session.submit(request) { c.resume(with: $0.mapError { $0 as Error }) } }
            catch { c.resume(throwing: error) }
        }
    }
    private func dispose(_ view: NativeEditorView) async {
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }
    private func fixture(_ body: @MainActor (NativeEditorView) async throws -> Void) async throws {
        _ = NSApplication.shared
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("editac-clipboard-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        let options = NativeSessionOptions(path: dir.appendingPathComponent("session.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil)
        do {
            let _: NativeSessionResponse = try await withCheckedThrowingContinuation { c in
                do { try view.session.open(options: options, initial: [NativeSessionSeed(kind: "block", text: "A🦀B")], now: 0) {
                    c.resume(with: $0.mapError { $0 as Error })
                } } catch { c.resume(throwing: error) }
            }
            XCTAssertNil(view.projectionFailure)
            view.textView.setSelectedRange(NSRange(location: 1, length: 2))
            try await body(view)
        } catch { await dispose(view); throw error }
        if !view.isDisposed { await dispose(view) }
    }
    private func unchanged(_ view: NativeEditorView) {
        XCTAssertEqual(view.textView.string, "A🦀B")
    }

    func testActualPasteboardRoundTripsAllOwnedFlavors() throws {
        try board { board in
            var values = Dictionary(uniqueKeysWithValues: NativeClipboardFlavor.allCases.map { ($0, Data("fixture:\($0.rawValue)🦀".utf8)) })
            values[.rtf] = Data([0x7b, 0x5c, 0x72, 0x74, 0x66, 0xff, 0x7d])
            let offer = try NativeClipboardOffer(values)
            let receipt = try NativeClipboardTransport.publish(offer, to: board)
            XCTAssertTrue(receipt.isCurrent(on: board))
            XCTAssertEqual(try NativeClipboardTransport.read(from: board), offer)
        }
    }
    func testLiteralModeExcludesEveryRichCandidate() throws {
        let offer = try NativeClipboardOffer([.fragment: Data("{}".utf8), .markdown: Data("**x**".utf8), .html: Data("<b>x</b>".utf8), .plain: Data("x".utf8)])
        XCTAssertEqual(offer.candidates(literal: true), [.plain])
        XCTAssertEqual(offer.candidates(literal: false), [.fragment, .markdown, .html, .plain])
        XCTAssertEqual(NativeClipboardFlavor.fragment.mimeType, "application/x-edit-ac-fragment+json")
        XCTAssertEqual(NativeClipboardFlavor.extensionOffer.mimeType, "application/x-edit-ac-extension+json")
    }
    func testOversizeFlavorRejectsBeforeClipboardReplacement() throws {
        try board { board in
            let original = try NativeClipboardTransport.publish(offer("preserve"), to: board)
            XCTAssertThrowsError(try NativeClipboardOffer([.plain: Data(repeating: 65, count: 1_048_577)])) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .oversized)
            }
            XCTAssertTrue(original.isCurrent(on: board))
        }
    }
    func testIndependentFlavorLimitsRetainCompleteRichAndLiteralBytes() throws {
        try board { board in
            let bytes = Data(repeating: 65, count: NativeClipboardOffer.maximumFlavorBytes)
            let payload = try NativeClipboardOffer([.html: bytes, .plain: bytes])
            _ = try NativeClipboardTransport.publish(payload, to: board)
            XCTAssertEqual(try NativeClipboardTransport.read(from: board), payload)
        }
    }
    func testOversizeIncomingOSFlavorIsDiagnosed() throws {
        try board { board in
            let item = NSPasteboardItem()
            item.setData(Data(repeating: 65, count: NativeClipboardOffer.maximumFlavorBytes + 1), forType: .string)
            XCTAssertTrue(board.writeObjects([item]))
            XCTAssertThrowsError(try NativeClipboardTransport.read(from: board)) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .oversized)
            }
        }
    }
    func testInvalidUTF8DiagnosedWithoutReplacingClipboard() throws {
        try board { board in
            let original = try NativeClipboardTransport.publish(offer(), to: board)
            XCTAssertThrowsError(try NativeClipboardOffer([.fragment: Data([0xff])])) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .invalidUTF8(.fragment))
            }
            XCTAssertTrue(original.isCurrent(on: board))
        }
    }
    func testMultipleOSItemsRejectWithoutSilentlyDroppingData() throws {
        try board { board in
            let a = NSPasteboardItem(); a.setString("a", forType: .string)
            let b = NSPasteboardItem(); b.setString("b", forType: .string)
            XCTAssertTrue(board.writeObjects([a, b]))
            XCTAssertThrowsError(try NativeClipboardTransport.read(from: board)) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .multipleItems)
            }
        }
    }
    func testUnsupportedOSFlavorIsExplicit() throws {
        try board { board in
            let item = NSPasteboardItem(); item.setData(Data([1, 2]), forType: .init("ac.fixture.unknown"))
            XCTAssertTrue(board.writeObjects([item]))
            XCTAssertThrowsError(try NativeClipboardTransport.read(from: board)) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .unsupportedTypes)
            }
        }
    }
    func testOwnedPromisedOfferSurvivesActualSourceDisposal() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        var publication: NativeClipboardPublication?
        try await fixture { view in
            publication = try NativeClipboardTransport.publish(offer(view.textView.string), to: board, promised: true)
            await dispose(view)
        }
        XCTAssertTrue(try XCTUnwrap(publication).isCurrent(on: board))
        XCTAssertEqual(try NativeClipboardTransport.read(from: board).values[.plain], Data("A🦀B".utf8))
    }
    func testPublicationAcknowledgementInvalidatedByOtherOwner() throws {
        try board { board in
            let original = try NativeClipboardTransport.publish(offer(), to: board)
            _ = try NativeClipboardTransport.publish(offer("other"), to: board)
            XCTAssertFalse(original.isCurrent(on: board))
        }
    }
    func testUntrustedMarkupRemainsDataForSharedSanitizer() throws {
        try board { board in
            let bytes = Data("<script>fixture()</script><img src='https://invalid.example/x'>".utf8)
            let payload = try NativeClipboardOffer([.html: bytes, .plain: Data("fixture".utf8)])
            _ = try NativeClipboardTransport.publish(payload, to: board)
            XCTAssertEqual(try NativeClipboardTransport.read(from: board).values[.html], bytes)
            // Transport neither executes nor claims to sanitize these bytes.
        }
    }
    func testActualOSProviderDeliversOnceToCapturedSessionWithoutMutation() async throws {
        try await fixture { view in
            let gate = ProviderGate()
            let finished = expectation(description: "delivered")
            var deliveries = 0
            let revision = view.sessionSnapshot!.revision
            let read = try view.clipboard.begin { result in
                deliveries += 1
                guard case let .success(delivery) = result else { XCTFail("provider failed"); finished.fulfill(); return }
                XCTAssertEqual(delivery.offer.values[.plain], Data("provided".utf8))
                XCTAssertEqual(delivery.target.revision, revision)
                XCTAssertEqual(delivery.target.anchor.offsetUTF16, 1)
                XCTAssertEqual(delivery.target.focus.offsetUTF16, 3)
                finished.fulfill()
            }
            try read.load(from: gate.provider)
            await fulfillment(of: [gate.started], timeout: 5)
            gate.deliver(Data("provided".utf8))
            await fulfillment(of: [finished], timeout: 5)
            read.receive(.success(try offer("duplicate")))
            XCTAssertEqual(deliveries, 1); XCTAssertEqual(view.clipboard.pendingCount, 0)
            unchanged(view)
        }
    }
    func testOSProviderFailurePreservesSource() async throws {
        try await fixture { view in
            let gate = ProviderGate(); let finished = expectation(description: "failure")
            let read = try view.clipboard.begin { result in
                guard case .failure(.providerFailed) = result else { XCTFail("expected provider failure"); finished.fulfill(); return }
                finished.fulfill()
            }
            try read.load(from: gate.provider)
            await fulfillment(of: [gate.started], timeout: 5)
            gate.deliver(nil, error: FixtureFailure())
            await fulfillment(of: [finished], timeout: 5)
            unchanged(view)
        }
    }
    func testCancellationDuringActualOSProviderLoadIsFinal() async throws {
        try await fixture { view in
            let gate = ProviderGate(); var callbacks = 0
            let read = try view.clipboard.begin { result in
                callbacks += 1
                guard case .failure(.cancelled) = result else { XCTFail("expected cancellation"); return }
            }
            try read.load(from: gate.provider)
            await fulfillment(of: [gate.started], timeout: 5)
            read.cancel(); read.receive(.success(try offer()))
            gate.deliver(Data("late".utf8))
            XCTAssertEqual(callbacks, 1); XCTAssertTrue(read.isFinished)
            XCTAssertEqual(view.clipboard.pendingCount, 0); unchanged(view)
        }
    }
    func testReadOnlySessionRejectsBeforeRequestingProvider() async throws {
        try await fixture { view in
            _ = try await send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            XCTAssertThrowsError(try view.clipboard.begin { _ in XCTFail("must not begin") }) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .readOnly)
            }
            unchanged(view)
        }
    }
    func testRevocationWhileProviderIsDelayedRejectsDelivery() async throws {
        try await fixture { view in
            let gate = ProviderGate(); let finished = expectation(description: "revoked")
            let read = try view.clipboard.begin { result in
                guard case .failure(.readOnly) = result else { XCTFail("expected revocation"); finished.fulfill(); return }
                finished.fulfill()
            }
            try read.load(from: gate.provider)
            await fulfillment(of: [gate.started], timeout: 5)
            _ = try await send(view, .commandPermission(writable: false, expiresAt: nil, now: 0))
            gate.deliver(Data("late".utf8))
            await fulfillment(of: [finished], timeout: 5)
            unchanged(view)
        }
    }
    func testChangedRevisionRejectsCapturedTransportCoordinates() async throws {
        try await fixture { view in
            var failure: NativeClipboardFailure?
            let read = try view.clipboard.begin { if case let .failure(error) = $0 { failure = error } }
            let snapshot = view.sessionSnapshot!
            _ = try await send(view, .nativeEdit(revision: snapshot.revision!, edits: [NativeSessionEdit(
                node: snapshot.nodes[0].id, fromUtf16: 0, toUtf16: 0, text: "changed")], now: 0))
            read.receive(.success(try offer("late")))
            XCTAssertEqual(failure, .staleTarget)
            XCTAssertEqual(view.textView.string, "changedA🦀B")
        }
    }
    func testDisposalCancelsPendingReadsAndIgnoresLateData() async throws {
        try await fixture { view in
            var callbacks = 0
            let read = try view.clipboard.begin { result in
                callbacks += 1
                guard case .failure(.cancelled) = result else { XCTFail("expected disposal cancellation"); return }
            }
            await dispose(view)
            read.receive(.success(try offer()))
            XCTAssertEqual(callbacks, 1); XCTAssertEqual(view.clipboard.pendingCount, 0)
        }
    }
    func testTwoIndependentViewsKeepOriginalCapturedTarget() async throws {
        try await fixture { source in
            try await fixture { destination in
                var delivered: NativeClipboardDelivery?
                let read = try source.clipboard.begin { if case let .success(value) = $0 { delivered = value } }
                let original = try source.projection.capture(range: source.textView.selectedRange(), backwards: false, affinity: .downstream)
                destination.textView.setSelectedRange(NSRange(location: 4, length: 0))
                source.textView.setSelectedRange(NSRange(location: 0, length: 0))
                read.receive(.success(try offer()))
                XCTAssertEqual(delivered?.target.anchor, original.anchor)
                XCTAssertEqual(delivered?.target.focus, original.focus)
                XCTAssertNotEqual(delivered?.target.revision, destination.sessionSnapshot?.revision)
                unchanged(source); unchanged(destination)
            }
        }
    }
    func testLiteralOSProviderNeverRequestsRichFlavor() async throws {
        try await fixture { view in
            let gate = ProviderGate()
            gate.provider.registerDataRepresentation(forTypeIdentifier: NativeClipboardFlavor.html.rawValue, visibility: .all) { _ in
                XCTFail("literal mode called rich provider"); return nil
            }
            let finished = expectation(description: "literal")
            let read = try view.clipboard.begin { result in
                guard case let .success(value) = result else { XCTFail("literal failed"); finished.fulfill(); return }
                XCTAssertEqual(value.offer.candidates(literal: false), [.plain]); finished.fulfill()
            }
            try read.load(from: gate.provider, literal: true)
            await fulfillment(of: [gate.started], timeout: 5)
            gate.deliver(Data("<b>literal</b>".utf8))
            await fulfillment(of: [finished], timeout: 5)
            unchanged(view)
        }
    }
    func testOSProviderRetainsRichAndLiteralRepresentationsTogether() async throws {
        try await fixture { view in
            let provider = NSItemProvider()
            let rich = Data("{\"fixture\":true}".utf8)
            let plain = Data("literal".utf8)
            provider.registerDataRepresentation(forTypeIdentifier: NativeClipboardFlavor.fragment.rawValue, visibility: .all) { done in
                done(rich, nil); return nil
            }
            provider.registerDataRepresentation(forTypeIdentifier: NativeClipboardFlavor.plain.rawValue, visibility: .all) { done in
                done(plain, nil); return nil
            }
            let finished = expectation(description: "all flavors")
            let read = try view.clipboard.begin { result in
                guard case let .success(value) = result else { XCTFail("multi-flavor failed"); finished.fulfill(); return }
                XCTAssertEqual(value.offer.values, [.fragment: rich, .plain: plain]); finished.fulfill()
            }
            try read.load(from: provider)
            await fulfillment(of: [finished], timeout: 5)
            unchanged(view)
        }
    }
    func testMalformedOSProviderBytesAreDiagnosedWithoutMutation() async throws {
        try await fixture { view in
            let gate = ProviderGate(); let finished = expectation(description: "invalid bytes")
            let read = try view.clipboard.begin { result in
                guard case .failure(.invalidUTF8(.plain)) = result else { XCTFail("expected invalid UTF-8"); finished.fulfill(); return }
                finished.fulfill()
            }
            try read.load(from: gate.provider)
            await fulfillment(of: [gate.started], timeout: 5)
            gate.deliver(Data([0xff]))
            await fulfillment(of: [finished], timeout: 5)
            unchanged(view)
        }
    }
    func testDuplicateLoadCannotStartAnotherProvider() async throws {
        try await fixture { view in
            let gate = ProviderGate()
            let read = try view.clipboard.begin { _ in }
            try read.load(from: gate.provider)
            XCTAssertThrowsError(try read.load(from: gate.provider)) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .alreadyConsumed)
            }
            await fulfillment(of: [gate.started], timeout: 5)
            read.cancel(); gate.deliver(nil, error: FixtureFailure())
            XCTAssertThrowsError(try read.load(from: gate.provider)) {
                XCTAssertEqual($0 as? NativeClipboardFailure, .alreadyConsumed)
            }
            unchanged(view)
        }
    }
}
