import AppKit

/// A host callback is valid for one coordinator, document activation and policy
/// generation. It is presentation scope, never a shared authorization lease.
public struct NativeDocumentScope: Sendable, Equatable {
    fileprivate let owner: UUID
    fileprivate let generation: UUID
}

/// Local native lifecycle prerequisite for collaboration. The shared Session
/// remains the only document, history, permission and durable receipt owner.
@MainActor
public final class NativeDocumentCoordinator {
    public enum Phase: Sendable, Equatable { case ready, opening, closing, revoking, closed }
    public typealias Completion = @MainActor @Sendable (Result<NativeEditorView, NativeSessionFailure>) -> Void
    public private(set) var editor: NativeEditorView
    public private(set) var phase: Phase = .ready
    private let owner = UUID()
    private var generation = UUID()
    private var candidate: NativeEditorView?
    private var completion: Completion?

    /// The host transfers lifecycle ownership of an already opened editor.
    public init(editor: NativeEditorView) { self.editor = editor }
    public var scope: NativeDocumentScope { NativeDocumentScope(owner: owner, generation: generation) }

    /// Call immediately before applying a delayed host presentation result. This
    /// cannot make an asynchronous semantic mutation safe; use shared anchors.
    @discardableResult
    public func deliver(ifCurrent scope: NativeDocumentScope,
                        _ body: @MainActor (NativeEditorView) -> Void) -> Bool {
        guard phase == .ready || phase == .opening,
              scope == self.scope, !editor.isDisposed else { return false }
        body(editor)
        return true
    }

    /// Opens/restores a private candidate before closing the old owner. Failed
    /// opening leaves old input/selection intact. Once durable close starts the
    /// switch cannot be cancelled: already accepted work must settle first.
    public func switchDocument(options: NativeSessionOptions, initial: [NativeSessionSeed]? = nil,
                               now: UInt64, completion: @escaping Completion) {
        guard phase == .ready, !editor.isDisposed else { completion(.failure(.closing)); return }
        phase = .opening
        self.completion = completion
        let next = NativeEditorView(frame: editor.frame)
        candidate = next
        do {
            try next.session.open(options: options, initial: initial, now: now) { [self] result in
                guard candidate === next, phase == .opening else { return }
                switch result {
                case let .failure(error): discardCandidate(error)
                case .success:
                    // Invalidate host results and all captured OS replacements
                    // before the shared close admission barrier is queued.
                    phase = .closing
                    generation = UUID()
                    editor.collaboration.disconnect()
                    editor.composition.invalidateHostInput()
                    editor.attachments.cancelAll()
                    editor.storage.close { [self] result in
                        switch result {
                        case let .failure(error): discardCandidate(error)
                        case .success:
                            editor = next
                            candidate = nil
                            phase = .ready
                            finish(.success(next))
                        }
                    }
                }
            }
        } catch { discardCandidate(error as? NativeSessionFailure ?? .unexpected(String(describing: error))) }
    }

    /// Cancellation applies only to private candidate opening. Completion waits
    /// for its queued work and actual Rust/SQLite disposal, without touching old.
    @discardableResult
    public func cancelSwitch() -> Bool {
        guard phase == .opening else { return false }
        discardCandidate(.cancelled)
        return true
    }

    /// A trusted local policy change, not transport authentication or remote
    /// receipt settlement. Earlier admitted edits retain their durable receipts.
    public func revoke(now: UInt64, completion: @escaping NativeSessionExecutor.Completion) {
        guard phase == .ready, !editor.isDisposed else { completion(.failure(.closing)); return }
        phase = .revoking
        generation = UUID()
        editor.collaboration.disconnect()
        editor.composition.invalidateHostInput()
        editor.attachments.cancelAll()
        editor.textView.isEditable = false
        do {
            try editor.session.submit(.commandPermission(writable: false, expiresAt: nil, now: now)) { [self] result in
                phase = .ready
                completion(result)
            }
        } catch {
            phase = .ready
            completion(.failure(error as? NativeSessionFailure ?? .unexpected(String(describing: error))))
        }
    }

    public func close(completion: @escaping @MainActor @Sendable (Result<Void, NativeSessionFailure>) -> Void) {
        guard phase == .ready else { completion(.failure(.closing)); return }
        phase = .closing
        generation = UUID()
        editor.collaboration.disconnect()
        editor.composition.invalidateHostInput()
        editor.attachments.cancelAll()
        editor.storage.close { [self] result in
            if case .success = result { phase = .closed } else { phase = .ready }
            completion(result)
        }
    }

    private func discardCandidate(_ failure: NativeSessionFailure) {
        guard let next = candidate else { return }
        candidate = nil
        // Keep the coordinator busy until actual candidate destruction completes.
        phase = .closing
        next.dispose { [self] in
            phase = .ready
            finish(.failure(failure))
        }
    }
    private func finish(_ result: Result<NativeEditorView, NativeSessionFailure>) {
        let callback = completion
        completion = nil
        callback?(result)
    }
}
