import Foundation
@_exported import EditacNative

public enum NativeSessionFailure: Error, Sendable {
    case native(NativeSessionError)
    case notOpen
    case alreadyOpen
    case cancelled
    case disposed
    case unexpected(String)
}

/// Requests reuse the shared Session's owned values, revision and admission rules.
public enum NativeSessionRequest: Sendable {
    case read(now: UInt64)
    case prepare(revision: Data, edits: [NativeSessionEdit], origin: String, now: UInt64)
    case commit(token: String, now: UInt64)
    case cancelPrepared(token: String)
    case undo(revision: Data, now: UInt64)
    case redo(revision: Data, now: UInt64)
    case permission(writable: Bool, expiresAt: UInt64?)
    case recover
    case recoveryExport
}

public enum NativeSessionResponse: Sendable {
    case snapshot(NativeSessionRead)
    case prepared(String)
    case committed(NativeSessionCommit?)
    case recovery(NativeSessionRecovery)
    case completed
}

/// Cancellation only prevents work that has not started. Once accepted, a shared
/// commit cannot be rolled back by cancelling its UI request. Dispose suppresses
/// delivery independently and waits for accepted work before releasing the owner.
public final class NativeSessionOperation: @unchecked Sendable {
    private let lock = NSLock()
    private var started = false
    private var cancelled = false

    @discardableResult
    public func cancel() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !started else { return false }
        cancelled = true
        return true
    }

    fileprivate func begin() -> Bool {
        lock.lock(); defer { lock.unlock() }
        started = true
        return !cancelled
    }
}

/// This state is touched only by SessionWorker's serial queue. A Rust handle is
/// never exposed to callers, and destruction is also submitted to that queue.
private final class SessionState: @unchecked Sendable {
    var session: NativeSession?
    func close() {
        try? session?.dispose()
        session = nil
    }
}

private final class SessionWorker: Sendable {
    let queue = DispatchQueue(label: "ac.edit.macos.session", qos: .userInitiated)
    let state = SessionState()

    func close(_ completion: @escaping @MainActor @Sendable () -> Void) {
        queue.async { [state] in
            state.close()
            DispatchQueue.main.async { completion() }
        }
    }

    deinit {
        queue.async { [state] in state.close() }
    }
}

/// AppKit owns admission and callback delivery on MainActor; synchronous SQLite
/// and shared Session calls execute off-main in submission order. Call dispose
/// at the host's view/document lifecycle boundary; final release is a safety net.
@MainActor
public final class NativeSessionExecutor {
    public typealias Completion = @MainActor @Sendable (Result<NativeSessionResponse, NativeSessionFailure>) -> Void
    private let worker = SessionWorker()
    private var disposed = false
    private var nextID: UInt64 = 0
    private var completions: [UInt64: Completion] = [:]
    private var operations: [UInt64: NativeSessionOperation] = [:]
    public var onResult: Completion?

    public init() {}

    @discardableResult
    public func open(options: NativeSessionOptions, initial: [NativeSessionSeed]? = nil,
                     now: UInt64, completion: Completion? = nil) throws -> NativeSessionOperation {
        try enqueue(completion: completion) { state in
            guard state.session == nil else { throw NativeSessionFailure.alreadyOpen }
            let session: NativeSession
            if let initial {
                session = try NativeSession.createLocal(options: options, initial: initial)
            } else {
                session = try NativeSession.open(options: options)
            }
            // Retain only after the owned initial read succeeds. A failed open/read
            // leaves no hidden writer reservation and permits a later retry.
            do {
                let snapshot = try session.read(now: now)
                state.session = session
                return .snapshot(snapshot)
            } catch {
                try? session.dispose()
                throw error
            }
        }
    }

    @discardableResult
    public func submit(_ request: NativeSessionRequest, completion: Completion? = nil) throws -> NativeSessionOperation {
        try enqueue(completion: completion) { state in
            guard let session = state.session else { throw NativeSessionFailure.notOpen }
            switch request {
            case let .read(now): return .snapshot(try session.read(now: now))
            case let .prepare(revision, edits, origin, now):
                return .prepared(try session.prepareEdits(revision: revision, edits: edits, origin: origin, now: now))
            case let .commit(token, now): return .committed(try session.commitEdits(token: token, now: now))
            case let .cancelPrepared(token): try session.cancelEdits(token: token)
            case let .undo(revision, now): return .committed(try session.undo(revision: revision, now: now))
            case let .redo(revision, now): return .committed(try session.redo(revision: revision, now: now))
            case let .permission(writable, expiry): try session.setPermission(writable: writable, expiresAt: expiry)
            case .recover: try session.recover()
            case .recoveryExport: return .recovery(try session.recoveryExport())
            }
            return .completed
        }
    }

    /// Stops admission immediately. The completion is a lifecycle barrier after
    /// accepted operations and actual Rust disposal, never a view update callback.
    public func dispose(completion: @escaping @MainActor @Sendable () -> Void = {}) {
        disposed = true
        for operation in operations.values { operation.cancel() }
        operations.removeAll()
        completions.removeAll()
        onResult = nil
        worker.close(completion)
    }

    private func enqueue(completion: Completion?,
                         work: @escaping @Sendable (SessionState) throws -> NativeSessionResponse) throws -> NativeSessionOperation {
        guard !disposed else { throw NativeSessionFailure.disposed }
        nextID += 1
        let id = nextID
        let operation = NativeSessionOperation()
        operations[id] = operation
        if let completion { completions[id] = completion }
        worker.queue.async { [weak self, state = worker.state] in
            let result: Result<NativeSessionResponse, NativeSessionFailure>
            do {
                guard operation.begin() else { throw NativeSessionFailure.cancelled }
                result = .success(try work(state))
            } catch let error as NativeSessionFailure {
                result = .failure(error)
            } catch let error as NativeSessionError {
                result = .failure(.native(error))
            } catch {
                result = .failure(.unexpected(String(describing: error)))
            }
            // One FIFO queue delivers directly to the main queue; no unstructured
            // tasks can reorder results. Never capture the view or owner strongly.
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.disposed else { return }
                self.operations.removeValue(forKey: id)
                let completion = self.completions.removeValue(forKey: id)
                self.onResult?(result)
                guard !self.disposed else { return }
                completion?(result)
            }
        }
        return operation
    }

    deinit {
        for operation in operations.values { operation.cancel() }
    }

    // A deterministic test barrier for races uses the same serial queue, never a
    // fake Session or sleeps. Internal to the native adapter test target.
    func enqueueBarrier(_ barrier: @escaping @Sendable () -> Void) {
        worker.queue.async(execute: barrier)
    }
}
