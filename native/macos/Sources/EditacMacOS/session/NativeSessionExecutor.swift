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
    case retainSelection(revision: Data, inputs: [AnchorInput])
    case releaseSelection
    case resyncProjection
    case nativeEdit(revision: Data, edits: [NativeSessionEdit], now: UInt64)
    case captureInput(id: UUID, revision: Data, inputs: [AnchorInput])
    case releaseInput(id: UUID)
    case cancelInput(id: UUID, now: UInt64)
    case capturedEdit(id: UUID, selected: String, text: String, now: UInt64)
    case prepare(revision: Data, edits: [NativeSessionEdit], origin: String, now: UInt64)
    case commit(token: String, now: UInt64)
    case cancelPrepared(token: String)
    case commandCheck(revision: Data, json: String, origin: String, now: UInt64)
    case commandBatch(revision: Data, json: String, origin: String, now: UInt64)
    case commandAt(revision: Data, input: AnchorInput, end: UInt32, owner: String,
                   route: String, checkOnly: Bool, now: UInt64)
    case undo(revision: Data, now: UInt64)
    case redo(revision: Data, now: UInt64)
    case permission(writable: Bool, expiresAt: UInt64?)
    case commandPermission(writable: Bool, expiresAt: UInt64?, now: UInt64)
    case recover
    case recoveryExport
}

public enum NativeSessionResponse: Sendable {
    case snapshot(NativeSessionRead)
    case inputCommitted(NativeSessionRead, node: String, caret: UInt32)
    case inputRestored(NativeSessionRead, node: String?, start: UInt32, end: UInt32)
    case prepared(String)
    case committed(NativeSessionCommit?)
    case recovery(NativeSessionRecovery)
    case completed
    case anchors([NativeSessionAnchor])
}

public struct NativeProjectionUpdate: Sendable {
    public let snapshot: NativeSessionProjection?
    public let patches: NativeSessionPatches?
    public let selection: [NativeSessionAnchorRead]
    public let commandCatalog: NativeCommandCatalog?
    public let history: NativeSessionHistory?
    init(snapshot: NativeSessionProjection?, patches: NativeSessionPatches?, selection: [NativeSessionAnchorRead],
         commandCatalog: NativeCommandCatalog? = nil, history: NativeSessionHistory? = nil) {
        self.snapshot = snapshot; self.patches = patches; self.selection = selection
        self.commandCatalog = commandCatalog; self.history = history
    }
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
    var now: UInt64 = 0
    var projectionSequence: UInt64?
    var selection: [NativeSessionAnchor] = []
    var inputTargets: [UUID: [NativeSessionAnchor]] = [:]

    func projection() throws -> NativeProjectionUpdate {
        guard let session else { throw NativeSessionFailure.notOpen }
        let snapshot: NativeSessionProjection?
        let patches: NativeSessionPatches?
        if let sequence = projectionSequence {
            do {
                patches = try session.takeRichPatches(afterSequence: sequence)
                snapshot = nil
            } catch NativeSessionError.ProjectionResyncRequired {
                snapshot = try session.richSnapshot(); patches = nil
            }
        } else {
            snapshot = try session.richSnapshot(); patches = nil
        }
        projectionSequence = snapshot?.sequence ?? patches?.sequence
        return NativeProjectionUpdate(snapshot: snapshot, patches: patches,
            selection: try selection.map { try session.resolveAnchor(token: $0.token) },
            commandCatalog: try session.commandCatalog(now: now), history: try session.historyState(now: now))
    }

    func releaseSelection() throws {
        for anchor in selection { try session?.releaseAnchor(token: anchor.token) }
        selection = []
    }
    func close() {
        selection = []; inputTargets = [:]; projectionSequence = nil
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
    public var onProjection: (@MainActor @Sendable (Result<NativeProjectionUpdate, NativeSessionFailure>) -> Void)?

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
                state.now = now
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
            // Use the caller's Session clock for command observations as well as
            // the mutation/read. Never substitute a wall clock for fixture time.
            switch request {
            case let .read(now), let .nativeEdit(_, _, now), let .capturedEdit(_, _, _, now),
                 let .cancelInput(_, now), let .prepare(_, _, _, now), let .commit(_, now),
                 let .undo(_, now), let .redo(_, now), let .commandPermission(_, _, now),
                 let .commandCheck(_, _, _, now), let .commandBatch(_, _, _, now),
                 let .commandAt(_, _, _, _, _, _, now): state.now = now
            default: break
            }
            switch request {
            case let .read(now): return .snapshot(try session.read(now: now))
            case let .captureInput(id, revision, inputs):
                guard inputs.count == 2, state.inputTargets[id] == nil else { throw NativeSessionFailure.cancelled }
                state.inputTargets[id] = try session.captureAnchors(revision: revision, inputs: inputs)
            case let .releaseInput(id):
                for anchor in state.inputTargets.removeValue(forKey: id) ?? [] {
                    try session.releaseAnchor(token: anchor.token)
                }
            case let .cancelInput(id, now):
                let anchors = state.inputTargets.removeValue(forKey: id) ?? []
                defer { for anchor in anchors { try? session.releaseAnchor(token: anchor.token) } }
                let positions = try anchors.map { try session.resolveAnchor(token: $0.token) }
                state.projectionSequence = nil
                let snapshot = try session.read(now: now)
                if positions.count == 2,
                   case let .position(a, start, _, _, _) = positions[0].resolution,
                   case let .position(b, end, _, _, _) = positions[1].resolution,
                   a == b, start <= end {
                    return .inputRestored(snapshot, node: a, start: start, end: end)
                }
                return .inputRestored(snapshot, node: nil, start: 0, end: 0)
            case let .capturedEdit(id, selected, text, now):
                guard let anchors = state.inputTargets.removeValue(forKey: id), anchors.count == 2 else {
                    throw NativeSessionFailure.cancelled
                }
                defer { for anchor in anchors { try? session.releaseAnchor(token: anchor.token) } }
                let positions = try anchors.map { try session.resolveAnchor(token: $0.token) }
                guard case let .position(a, start, _, _, _) = positions[0].resolution,
                      case let .position(b, end, _, _, _) = positions[1].resolution,
                      a == b, start <= end else { throw NativeSessionFailure.cancelled }
                let current = try session.read(now: now)
                guard let node = current.nodes.first(where: { $0.id == a }),
                      let range = Range(NSRange(location: Int(start), length: Int(end - start)), in: node.text),
                      node.text[range].utf16.elementsEqual(selected.utf16),
                      let revision = current.revision else { throw NativeSessionFailure.cancelled }
                // Resolve, compare and admit atomically on the single Session queue.
                // No native caret or stale display offset enters this operation.
                let token = try session.prepareEdits(revision: revision,
                    edits: [NativeSessionEdit(node: a, fromUtf16: start, toUtf16: end, text: text)],
                    origin: "appkit-captured-input", now: now)
                do { _ = try session.commitEdits(token: token, now: now) }
                catch { try? session.cancelEdits(token: token); throw error }
                // Skipped composing projections require a complete current snapshot.
                state.projectionSequence = nil
                return .inputCommitted(try session.read(now: now), node: a,
                                       caret: start + UInt32(text.utf16.count))
            case let .retainSelection(revision, inputs):
                let anchors = try session.captureAnchors(revision: revision, inputs: inputs)
                try state.releaseSelection()
                state.selection = anchors
                return .anchors(anchors)
            case .releaseSelection: try state.releaseSelection()
            case .resyncProjection: state.projectionSequence = nil
            case let .nativeEdit(revision, edits, now):
                // One queued operation owns prepare/commit/read; no UI callback or
                // unrelated request can interleave between these shared calls.
                var anchors: [NativeSessionAnchor] = []
                defer { for anchor in anchors { try? session.releaseAnchor(token: anchor.token) } }
                var commands: [[String: Any]] = []
                for edit in edits {
                    if edits.count == 1 && edit.fromUtf16 == edit.toUtf16 {
                        // A split boundary has two logical owners. Insertion is
                        // one right-biased anchor, never a zero-width range whose
                        // opposite endpoint biases can resolve to different nodes.
                        let captured = try session.captureAnchors(revision: revision, inputs: [
                            AnchorInput(node: edit.node, offsetUtf16: edit.fromUtf16, bias: .right)])
                        anchors += captured
                        commands.append(["type": "insert", "at": captured[0].token, "text": edit.text])
                    } else {
                        commands.append(["type": "replaceAt", "owner": edit.node,
                                         "from": edit.fromUtf16, "to": edit.toUtf16, "text": edit.text])
                    }
                }
                let json = String(data: try JSONSerialization.data(withJSONObject: commands), encoding: .utf8)!
                let token = try session.prepareCommands(revision: revision, commandsJson: json,
                    origin: "appkit-native-input", now: now).token
                do {
                    _ = try session.commitCommands(token: token, now: now)
                    return .snapshot(try session.read(now: now))
                } catch {
                    try? session.cancelEdits(token: token)
                    throw error
                }
            case let .prepare(revision, edits, origin, now):
                return .prepared(try session.prepareEdits(revision: revision, edits: edits, origin: origin, now: now))
            case let .commit(token, now): return .committed(try session.commitEdits(token: token, now: now))
            case let .cancelPrepared(token): try session.cancelEdits(token: token)
            case let .commandCheck(revision, json, origin, now):
                try session.checkCommands(revision: revision, commandsJson: json, origin: origin, now: now)
            case let .commandBatch(revision, json, origin, now):
                let plan = try session.prepareCommands(revision: revision, commandsJson: json, origin: origin, now: now)
                do { _ = try session.commitCommands(token: plan.token, now: now) }
                catch { try? session.cancelCommands(token: plan.token); throw error }
                return .snapshot(try session.read(now: now))
            case let .commandAt(revision, input, end, owner, route, checkOnly, now):
                let anchors = try session.captureAnchors(revision: revision, inputs: [input])
                defer { for anchor in anchors { try? session.releaseAnchor(token: anchor.token) } }
                var commands: [[String: Any]] = []
                if input.offsetUtf16 < end {
                    commands.append(["type": "replaceAt", "owner": owner,
                                     "from": input.offsetUtf16, "to": end, "text": ""])
                }
                var action: [String: Any] = ["type": route]
                if route != "hardBreak" { action["owner"] = owner }
                if route != "setParagraph" { action["at"] = anchors[0].token }
                commands.append(action)
                let json = String(data: try JSONSerialization.data(withJSONObject: commands), encoding: .utf8)!
                if checkOnly {
                    try session.checkCommands(revision: revision, commandsJson: json, origin: "appkit-split", now: now)
                    return .completed
                }
                let oldIDs = Set(try session.read(now: now).nodes.map(\.id))
                let plan = try session.prepareCommands(revision: revision, commandsJson: json,
                                                      origin: "appkit-split", now: now)
                do { _ = try session.commitCommands(token: plan.token, now: now) }
                catch { try? session.cancelCommands(token: plan.token); throw error }
                let snapshot = try session.read(now: now)
                // Enter may split, or exit an empty list while retaining its block.
                // Derive the caret from the actual shared result, never a native
                // imitation of list/heading semantics.
                let destination = snapshot.nodes.first { !oldIDs.contains($0.id) }?.id ?? owner
                return .inputCommitted(snapshot, node: destination,
                    caret: route == "hardBreak" ? input.offsetUtf16 + 1 : 0)
            case let .undo(revision, now): return .committed(try session.undo(revision: revision, now: now))
            case let .redo(revision, now): return .committed(try session.redo(revision: revision, now: now))
            case let .permission(writable, expiry): try session.setPermission(writable: writable, expiresAt: expiry)
            case let .commandPermission(writable, expiry, now):
                try session.setPermission(writable: writable, expiresAt: expiry)
                return .snapshot(try session.read(now: now))
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
        onProjection = nil
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
            var projection: Result<NativeProjectionUpdate, NativeSessionFailure>?
            do {
                guard operation.begin() else { throw NativeSessionFailure.cancelled }
                let response = try work(state)
                let projects: Bool
                switch response {
                case .snapshot, .inputCommitted, .inputRestored: projects = true
                default: projects = false
                }
                if projects {
                    do { projection = .success(try state.projection()) }
                    catch let error as NativeSessionError { projection = .failure(.native(error)) }
                    catch let error as NativeSessionFailure { projection = .failure(error) }
                    catch { projection = .failure(.unexpected(String(describing: error))) }
                }
                result = .success(response)
            } catch let error as NativeSessionFailure {
                result = .failure(error)
            } catch let error as NativeSessionError {
                result = .failure(.native(error))
            } catch {
                result = .failure(.unexpected(String(describing: error)))
            }
            // One FIFO queue delivers directly to the main queue; no unstructured
            // tasks can reorder results. Never capture the view or owner strongly.
            let update = projection
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.disposed else { return }
                if let update { self.onProjection?(update) }
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
