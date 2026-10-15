import AppKit

/// An already authenticated, host-owned transport. Implementations verify their
/// own envelope before admission. Journal identities/checksums are not credentials.
/// No network, key discovery or production authentication is supplied by the SDK.
@MainActor
public protocol NativeCollaborationTransport: AnyObject {
    func authorize(_ options: NativeHostTransportOptions) throws
    func admit(_ update: NativeSessionPeerUpdate) throws
    func admitPresence(_ frame: NativeHostFrame) throws
    func admitReceipt(_ receipt: NativeHostReceipt) throws
    func send(frames: [NativeHostFrame], updates: [NativeSessionPeerUpdate]) throws
    func sendPresence(_ frames: [NativeHostFrame]) throws
}

public struct NativeCollaborationScope: Sendable, Equatable {
    fileprivate let owner: UUID
    fileprivate let generation: UUID
    let token: String
}

/// Connection/presentation ownership only. The actual Session owns sync queues,
/// authorization leases, awareness, receipts, history and all document mutations.
@MainActor
public final class NativeCollaboration {
    public enum State: Equatable { case disconnected, connecting, connected, failed }
    public private(set) var state: State = .disconnected
    public private(set) var scope: NativeCollaborationScope?
    public private(set) var peers: [NativePeerPresence] = []
    public private(set) var remoteRanges: [UInt32: NSRange] = [:]
    public private(set) var lastFailure: NativeSessionFailure?
    public let statusLabel = NSTextField(labelWithString: "Collaboration disconnected")
    private weak var view: NativeEditorView?
    private var transport: (any NativeCollaborationTransport)?
    private let owner = UUID()
    private var generation = UUID()
    private var now: UInt64 = 0
    private var disposed = false
    private var busy = false
    private var flushing = false
    private let overlay = NativeRemoteSelectionOverlay(frame: .zero)

    init(view: NativeEditorView) {
        self.view = view
        overlay.frame = view.textView.bounds
        overlay.autoresizingMask = [.width, .height]
        view.textView.addSubview(overlay)
        statusLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        statusLabel.setAccessibilityLabel("Collaboration status")
    }
    private func valid(_ captured: NativeCollaborationScope) -> Bool {
        !disposed && view?.isDisposed == false && scope == captured && state == .connected
    }
    private func failure(_ error: Error) -> NativeSessionFailure {
        error as? NativeSessionFailure ?? (error as? NativeSessionError).map { .native($0) }
            ?? .unexpected(String(describing: error))
    }
    private func reject(_ completion: NativeSessionExecutor.Completion?) { completion?(.failure(.cancelled)) }
    private func updateLabel() {
        statusLabel.stringValue = state == .connected ? "Connected · \(peers.count) remote participants"
            : state == .connecting ? "Connecting" : state == .failed ? "Collaboration unavailable" : "Collaboration disconnected"
    }

    /// Host authorization runs before shared attach. Failed attach leaves an
    /// existing connection intact; the Rust token changes only on successful attach.
    public func connect(options: NativeHostTransportOptions, transport: any NativeCollaborationTransport,
                        now: UInt64, completion: NativeSessionExecutor.Completion? = nil) {
        guard let view, !disposed, !view.isDisposed, !busy, !flushing else { reject(completion); return }
        do {
            try transport.authorize(options)
            busy = true
            let previous = state
            state = .connecting; updateLabel()
            let attempt = generation
            try view.session.submit(.hostAttach(options: options, now: now)) { [weak self] result in
                guard let self, !self.disposed, self.generation == attempt else { return }
                self.busy = false
                switch result {
                case let .success(.hostConnection(token)):
                    self.generation = UUID()
                    self.scope = NativeCollaborationScope(owner: self.owner, generation: self.generation, token: token)
                    self.transport = transport; self.now = now; self.state = .connected; self.lastFailure = nil
                    self.clearPeers()
                case let .failure(error): self.state = previous; self.lastFailure = error
                default: self.state = previous; self.lastFailure = .cancelled
                }
                self.updateLabel(); completion?(result)
            }
        } catch {
            busy = false; lastFailure = failure(error); updateLabel(); completion?(.failure(failure(error)))
        }
    }

    /// Invalidates delayed events immediately; detach uses the same Session FIFO.
    public func disconnect(in captured: NativeCollaborationScope? = nil,
                           completion: NativeSessionExecutor.Completion? = nil) {
        if let captured, !valid(captured) { reject(completion); return }
        generation = UUID(); scope = nil; transport = nil; busy = false; flushing = false
        state = .disconnected; clearPeers(); updateLabel()
        guard let view, !view.isDisposed else { completion?(.success(.completed)); return }
        do { try view.session.submit(.hostDisconnect, completion: completion) }
        catch { completion?(.failure(failure(error))) }
    }

    /// One bounded page from the shared persistent outbox. Hosts retain the exact
    /// last identity as a cursor; sending never acknowledges remote durability.
    public func flush(_ captured: NativeCollaborationScope, after: NativeHostReceipt? = nil,
                      maxFrames: UInt32 = 32, now: UInt64,
                      completion: NativeSessionExecutor.Completion? = nil) {
        guard valid(captured), !flushing, let view, let transport else { reject(completion); return }
        self.now = now
        flushing = true
        let finish: NativeSessionExecutor.Completion = { [weak self] result in
            guard let self, !self.disposed, self.scope == captured else { return }
            self.flushing = false
            self.failed(result)
            completion?(result)
        }
        do {
            try view.session.submit(.pendingUpdates) { [weak self] pending in
                guard let self, self.valid(captured) else { return }
                guard case let .success(.peerUpdates(entries)) = pending else { finish(pending); return }
                do {
                    try view.session.submit(.hostFlush(token: captured.token, after: after, maxFrames: maxFrames, now: now)) { [weak self] flushed in
                        guard let self, self.valid(captured) else { return }
                        guard case .success = flushed else { self.failed(flushed); finish(flushed); return }
                        do {
                            try view.session.submit(.hostFrames(token: captured.token, maxFrames: maxFrames, now: now)) { [weak self] drained in
                                guard let self, self.valid(captured) else { return }
                                do {
                                    if case let .success(.hostFrames(frames)) = drained { try transport.send(frames: frames, updates: entries) }
                                    self.failed(drained); finish(drained)
                                } catch { self.lastFailure = self.failure(error); finish(.failure(self.failure(error))) }
                            }
                        } catch { finish(.failure(self.failure(error))) }
                    }
                } catch { finish(.failure(self.failure(error))) }
            }
        } catch { finish(.failure(failure(error))) }
    }
    private func failed(_ result: Result<NativeSessionResponse, NativeSessionFailure>) {
        if case let .failure(error) = result {
            lastFailure = error
            if case .native(.Unauthorized) = error { state = .failed; clearPeers() }
            if case .native(.RecoveryRequired) = error { state = .failed; clearPeers() }
            updateLabel()
        }
    }

    public func receive(_ update: NativeSessionPeerUpdate, in captured: NativeCollaborationScope,
                        now: UInt64, completion: NativeSessionExecutor.Completion? = nil) {
        guard valid(captured), let view, let transport else { reject(completion); return }
        self.now = now
        do {
            try view.session.receiveHostPeer(token: captured.token, update: update, now: now,
                admitting: { try transport.admit($0) }) { [weak self] result in
                    guard let self, self.valid(captured) else { return }
                    self.failed(result)
                    // A successful remote commit invalidates provisional input;
                    // restore from shared anchors before displaying the new model.
                    if case .success = result, view.composition.isActive { view.composition.cancel() }
                    completion?(result)
                }
        } catch { completion?(.failure(failure(error))) }
    }
    public func accept(_ receipt: NativeHostReceipt, in captured: NativeCollaborationScope,
                       now: UInt64, completion: NativeSessionExecutor.Completion? = nil) {
        guard valid(captured), let view, let transport else { reject(completion); return }
        do {
            try transport.admitReceipt(receipt)
            try view.session.submit(.hostReceipt(token: captured.token, receipt: receipt, now: now), completion: completion)
        } catch { completion?(.failure(failure(error))) }
    }

    /// Provisional IME text and its temporary selection are never published.
    public func publishSelection(in captured: NativeCollaborationScope, now: UInt64,
                                 completion: NativeSessionExecutor.Completion? = nil) {
        guard valid(captured), let view, !view.composition.isActive, !view.composition.isPending,
              let transport else { reject(completion); return }
        do {
            let selection = try view.projection.capture(range: view.textView.selectedRange(), backwards: false,
                affinity: view.textView.selectionAffinity)
            let inputs = try view.projection.anchorInputs(for: selection)
            try view.session.submit(.hostSetPresence(token: captured.token, revision: selection.revision,
                inputs: inputs, present: true, now: now)) { [weak self] result in
                guard let self, self.valid(captured) else { return }
                guard case .success = result else { self.failed(result); completion?(result); return }
                do {
                    try view.session.submit(.hostFlushPresence(token: captured.token, now: now)) { [weak self] flushed in
                        guard let self, self.valid(captured) else { return }
                        guard case .success = flushed else { self.failed(flushed); completion?(flushed); return }
                        do {
                            try view.session.submit(.hostPresenceFrames(token: captured.token, maxFrames: 32, now: now)) { [weak self] drained in
                                guard let self, self.valid(captured) else { return }
                                do {
                                    if case let .success(.hostFrames(frames)) = drained { try transport.sendPresence(frames) }
                                    completion?(drained)
                                } catch { completion?(.failure(self.failure(error))) }
                            }
                        } catch { completion?(.failure(self.failure(error))) }
                    }
                } catch { completion?(.failure(self.failure(error))) }
            }
        } catch { completion?(.failure(failure(error))) }
    }
    public func receivePresence(_ frame: NativeHostFrame, in captured: NativeCollaborationScope,
                                now: UInt64, completion: NativeSessionExecutor.Completion? = nil) {
        guard valid(captured), let view, let transport else { reject(completion); return }
        self.now = now
        do {
            try view.session.receiveHostPresence(token: captured.token, frame: frame, now: now,
                admitting: { try transport.admitPresence($0) }) { [weak self] result in
                    guard let self, self.valid(captured) else { return }
                    if case let .success(.hostPresence(peers)) = result { self.peers = peers; self.renderPeers() }
                    self.failed(result); completion?(result)
                }
        } catch { completion?(.failure(failure(error))) }
    }
    /// Host drives the monotonic clock, expiry and selection refresh. No timer or
    /// background network task is installed by the adapter.
    public func refresh(now: UInt64, completion: NativeSessionExecutor.Completion? = nil) {
        guard let captured = scope, valid(captured), let view else { reject(completion); return }
        self.now = now
        do {
            try view.session.submit(.hostPresence(token: captured.token, now: now)) { [weak self] result in
                guard let self, self.valid(captured) else { return }
                if case let .success(.hostPresence(peers)) = result { self.peers = peers; self.renderPeers() }
                else { self.clearPeers(); self.failed(result) }
                completion?(result)
            }
        } catch { completion?(.failure(failure(error))) }
    }
    func projectionDidChange() { if scope != nil { refresh(now: now) } }
    private func clearPeers() { peers = []; renderPeers() }
    private func renderPeers() {
        guard let view else { return }
        remoteRanges = [:]
        if !view.composition.isActive {
            for peer in peers {
                guard let selection = peer.selection,
                      case let .position(a, start, _, _, _) = selection.anchor,
                      case let .position(b, end, _, _, _) = selection.focus,
                      let left = view.projection.nodes.first(where: { $0.id == a }),
                      let right = view.projection.nodes.first(where: { $0.id == b }),
                      Int(start) <= left.range.length, Int(end) <= right.range.length else { continue }
                let x = left.range.location + Int(start), y = right.range.location + Int(end)
                let range = NSRange(location: min(x, y), length: abs(y - x))
                remoteRanges[peer.clientId] = range
            }
        }
        overlay.ranges = Array(remoteRanges.values)
        overlay.needsDisplay = true
        updateLabel()
    }
    func dispose() {
        disposed = true; generation = UUID(); scope = nil; transport = nil
        state = .disconnected; clearPeers(); updateLabel()
    }
}

/// Separate native presentation avoids changing text attributes, Find highlights,
/// committed storage or local selected ranges. It never participates in hit tests.
@MainActor
private final class NativeRemoteSelectionOverlay: NSView {
    var ranges: [NSRange] = []
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        guard let text = superview as? NSTextView, let layout = text.layoutManager,
              let container = text.textContainer else { return }
        layout.ensureLayout(for: container)
        for range in ranges {
            guard NSMaxRange(range) <= text.string.utf16.count else { continue }
            let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            if range.length == 0 {
                var rect: NSRect
                if range.location == text.string.utf16.count {
                    rect = layout.extraLineFragmentRect
                    if rect.isEmpty, layout.numberOfGlyphs > 0 {
                        rect = layout.boundingRect(forGlyphRange: NSRange(location: layout.numberOfGlyphs - 1, length: 1), in: container)
                        rect.origin.x = rect.maxX
                    }
                } else { rect = layout.boundingRect(forGlyphRange: NSRange(location: glyphs.location, length: 1), in: container) }
                rect.origin.x += text.textContainerOrigin.x; rect.origin.y += text.textContainerOrigin.y
                rect.size.width = 2
                NSColor.systemTeal.setFill(); rect.fill()
            } else {
                NSColor.systemTeal.withAlphaComponent(0.22).setFill()
                layout.enumerateEnclosingRects(forGlyphRange: glyphs,
                    withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { rect, _ in
                    rect.offsetBy(dx: text.textContainerOrigin.x, dy: text.textContainerOrigin.y).fill()
                }
            }
        }
    }
}
