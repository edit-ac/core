import AppKit

public enum NativeCommand: String, Sendable, CaseIterable {
    case undo, redo, selectAll, copy, find, cut, paste, pastePlainText, structural, serviceReplacement
    case bold, italic, underline, strike, alignLeft, paragraph, split, enter
}
public enum NativeCommandAvailability: Equatable, Sendable {
    case enabled, unfocused, unavailableSession, busy, readOnly, unavailablePort, emptyHistory, inapplicable, checking
}
public enum NativeCommandFailure: Error {
    case disabled(NativeCommandAvailability)
    case session(NativeSessionFailure)
    case invalidCommand
}

/// Responder admission only. Rust owns history, edits, permission and revision
/// validation. Portable route IDs and payloads come from the shared catalog;
/// the engine planner alone decides target applicability.
@MainActor
public final class NativeCommands {
    private weak var view: NativeEditorView?
    private struct TargetKey: Hashable {
        let revision: Data
        let range: NSRange
        let command: NativeCommand
    }
    private var targetResults: [TargetKey: Bool] = [:]
    private var validating: Set<TargetKey> = []
    private var checks: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var buttons: [WeakNativeCommandButton] = []
    private let notifications = NativeCommandNotifications()
    public private(set) var isPending = false
    public var now: @MainActor () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1_000) }
    public var find: (@MainActor () -> Void)? { didSet { refreshControls() } }
    /// Injected transfer owner returns portable commands for the captured range.
    /// This synchronous dispatch port owns no codec, clipboard lifetime or model.
    /// Delayed transfer is implemented by the clipboard owner, not this hook.
    public var transfer: (@MainActor (NativeCommand, NativeTextSelectionTarget) throws -> String)? {
        didSet { refreshControls() }
    }
    public private(set) var catalog: NativeCommandCatalog?
    public private(set) var history: NativeSessionHistory?

    func observe(catalog: NativeCommandCatalog, history: NativeSessionHistory) {
        if self.catalog != catalog { targetResults.removeAll() }
        self.catalog = catalog; self.history = history
    }

    public func profileAvailability(_ id: String) -> NativeCommandProfile? {
        catalog?.profiles.first { $0.id == id }
    }

    public var onResult: (@MainActor (Result<Void, NativeCommandFailure>) -> Void)?
    public private(set) var lastFailure: NativeCommandFailure?
    init(view: NativeEditorView) {
        self.view = view
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification] {
            notifications.tokens.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.refreshControls() }
            })
        }
    }

    /// The same NSButton can be hosted in a toolbar or NSCustomTouchBarItem.
    public func makeButton(_ command: NativeCommand, title: String) -> NativeCommandButton {
        let button = NativeCommandButton(command: command, title: title, owner: self)
        buttons.append(WeakNativeCommandButton(button)); refreshControls()
        return button
    }
    public func refreshControls() {
        view?.tables.refresh()
        view?.attachments.refresh()
        buttons.removeAll { $0.value == nil }
        for box in buttons {
            guard let button = box.value else { continue }
            button.isEnabled = availability(button.command) == .enabled
        }
    }

    public func availability(_ command: NativeCommand) -> NativeCommandAvailability {
        guard let view, !view.isDisposed, view.projectionFailure == nil,
              view.sessionSnapshot?.revision != nil else { return .unavailableSession }
        let cellRoute = view.tables.ownsFirstResponder && [.undo, .redo, .serviceReplacement].contains(command)
        guard view.window?.isKeyWindow == true,
              view.window?.firstResponder === view.textView || cellRoute else { return .unfocused }
        if command == .selectAll || command == .copy { return .enabled }
        if command == .find { return find == nil ? .unavailablePort : .enabled }
        guard !isPending, !view.input.isPending, !view.composition.isPending,
              !view.composition.isActive else { return .busy }
        guard view.sessionSnapshot?.canApply == true else { return .readOnly }
        switch command {
        case .undo, .redo:
            guard history?.canHistory == true else { return .readOnly }
            return (command == .undo ? history?.canUndo : history?.canRedo) == true ? .enabled : .emptyHistory
        case .serviceReplacement: return .enabled
        case .cut, .paste, .pastePlainText: return transfer == nil ? .unavailablePort : .enabled
        case .bold, .italic, .underline, .strike, .alignLeft, .paragraph, .split, .enter:
            guard let route = catalog?.routes.first(where: { $0.id == routeID(command) }),
                  route.available, route.canPrepare else { return .unavailablePort }
            guard (try? nativeRequest(command)) != nil, let key = targetKey(command) else { return .inapplicable }
            if let valid = targetResults[key] { return valid ? .enabled : .inapplicable }
            if validating.insert(key).inserted {
                Task { @MainActor [weak self] in _ = await self?.validate(command) }
            }
            return .checking
        default: return .unavailablePort
        }
    }

    /// Trusted host permission updates publish fresh enabled state on the same
    /// serialized owner before completion. Clocks use the Session's domain.
    @discardableResult
    public func setPermission(writable: Bool, expiresAt: UInt64?,
                              completion: NativeSessionExecutor.Completion? = nil) throws -> NativeSessionOperation {
        guard let view, !view.isDisposed else { throw NativeSessionFailure.disposed }
        return try view.session.submit(.commandPermission(writable: writable, expiresAt: expiresAt, now: now()),
                                       completion: completion)
    }

    /// Keyboard, menus, toolbar/touch and accessibility callers share this entry.
    /// Activation rechecks cached enablement; the serialized Session also checks
    /// current permission and observed revision at mutation time.
    public func perform(_ command: NativeCommand) {
        let state = availability(command)
        if state == .checking {
            Task { @MainActor [weak self] in
                guard let self else { return }
                let checked = await self.validate(command)
                if checked == .enabled { self.perform(command) }
                else { self.finish(.failure(.disabled(checked))) }
            }
            return
        }
        guard state == .enabled, let view else { finish(.failure(.disabled(state))); return }
        switch command {
        case .selectAll: view.textView.selectAll(nil); finish(.success(()))
        case .copy: view.textView.copy(nil); finish(.success(()))
        case .find: find?(); finish(.success(()))
        case .undo, .redo:
            guard let revision = view.sessionSnapshot?.revision else { return }
            isPending = true; view.textView.isEditable = false; refreshControls()
            do {
                let request: NativeSessionRequest = command == .undo
                    ? .undo(revision: revision, now: now()) : .redo(revision: revision, now: now())
                try view.session.submit(request) { [weak self] result in
                    self?.refresh(after: result)
                }
            } catch { refresh(after: .failure(error as? NativeSessionFailure ?? .unexpected(String(describing: error)))) }
        case .cut, .paste, .pastePlainText:
            do {
                let target = try selection()
                guard let transfer else { throw NativeCommandFailure.disabled(.unavailablePort) }
                perform(commandsJSON: try transfer(command, target), revision: target.revision)
            } catch { finish(.failure(error as? NativeCommandFailure ?? .invalidCommand)) }
        case .bold, .italic, .underline, .strike, .alignLeft, .paragraph, .split, .enter:
            do { execute(try nativeRequest(command)) }
            catch { finish(.failure(.invalidCommand)) }
        default: finish(.failure(.disabled(.unavailablePort)))
        }
    }

    private func targetKey(_ command: NativeCommand) -> TargetKey? {
        guard let view, let revision = view.sessionSnapshot?.revision else { return nil }
        return TargetKey(revision: revision, range: view.textView.selectedRange(), command: command)
    }

    /// Menus/buttons may initially report checking. Completion publishes exact
    /// target applicability, without blocking AppKit or retaining a Rust plan.
    @discardableResult
    public func validate(_ command: NativeCommand) async -> NativeCommandAvailability {
        guard [.bold, .italic, .underline, .strike, .alignLeft, .paragraph, .split, .enter].contains(command) else {
            return availability(command)
        }
        guard let view, !view.isDisposed, let key = targetKey(command) else { return .unavailableSession }
        let id = UUID()
        do {
            let request: NativeSessionRequest
            switch try nativeRequest(command) {
            case let .commandBatch(revision, json, origin, now):
                request = .commandCheck(revision: revision, json: json, origin: origin, now: now)
            case let .commandAt(revision, input, end, owner, route, _, now):
                request = .commandAt(revision: revision, input: input, end: end, owner: owner,
                                     route: route, checkOnly: true, now: now)
            default: return availability(command)
            }
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                checks[id] = c
                do { try view.session.submit(request) { [weak self] result in
                    self?.checks.removeValue(forKey: id)?.resume(with: result.map { _ in () }.mapError { $0 as Error })
                } } catch { checks.removeValue(forKey: id)?.resume(throwing: error) }
            }
            targetResults[key] = true
        } catch { targetResults[key] = false }
        validating.remove(key)
        // Bound cached selection variants; old revisions are never applicable.
        targetResults = targetResults.filter { $0.key.revision == catalog?.revision }
        if targetResults.count > 128 { targetResults = targetResults.filter { $0.key == key } }
        refreshControls()
        guard targetKey(command) == key else { return .inapplicable }
        return availability(command)
    }

    private func selection() throws -> NativeTextSelectionTarget {
        guard let view else { throw NativeCommandFailure.disabled(.unavailableSession) }
        return try view.projection.capture(range: view.textView.selectedRange(), backwards: false,
                                           affinity: view.textView.selectionAffinity)
    }
    private func routeID(_ command: NativeCommand) -> String {
        switch command {
        case .bold, .italic, .underline, .strike: return "markAt"
        case .alignLeft: return "setAlignment"
        case .paragraph: return "setParagraph"
        case .split: return "split"
        case .enter: return "enter"
        default: return ""
        }
    }
    private func nativeRequest(_ command: NativeCommand) throws -> NativeSessionRequest {
        let target = try selection()
        guard target.anchor.node == target.focus.node else { throw NativeCommandFailure.invalidCommand }
        let start = min(target.anchor.offsetUTF16, target.focus.offsetUTF16)
        let end = max(target.anchor.offsetUTF16, target.focus.offsetUTF16)
        if command == .split || command == .enter {
            var route = routeID(command)
            if command == .enter {
                // Choose a portable route from the shared projection, as native
                // Return has paragraph, code, heading and list contexts. Rust
                // still plans and validates the complete mutation.
                let node = view?.projection.richNodes[target.anchor.node]
                let parent = (node?.wire["parent"] as? String).flatMap { view?.projection.richNodes[$0] }
                let tuple = node?.wire["blockAttributes"] as? [Any]
                if tuple?.first as? String == "code" { route = "hardBreak" }
                else if parent?.kind == "list" || parent?.kind == "quote" { route = "enter" }
                else if tuple?.first as? String == "heading" {
                    if start == 0 && end == node?.text.utf16.count { route = "setParagraph" }
                    else { route = end == node?.text.utf16.count ? "headingEnd" : "split" }
                } else { route = "split" }
            }
            return .commandAt(revision: target.revision,
                input: AnchorInput(node: target.anchor.node, offsetUtf16: UInt32(start), bias: .right),
                end: UInt32(end), owner: target.anchor.node, route: route, checkOnly: false, now: now())
        }
        var value: [String: Any] = ["type": routeID(command), "owner": target.anchor.node]
        switch command {
        case .bold, .italic, .underline, .strike:
            guard start < end else { throw NativeCommandFailure.invalidCommand }
            value.merge(["from": start, "to": end, "mark": command.rawValue, "action": "toggle"]) { _, b in b }
        case .alignLeft: value["alignment"] = "left"
        default: break
        }
        let json = String(data: try JSONSerialization.data(withJSONObject: [value]), encoding: .utf8)!
        return .commandBatch(revision: target.revision, json: json, origin: "appkit-command", now: now())
    }

    /// Exact target applicability runs on the existing Rust planner. Metadata is
    /// not a promise that a payload applies. No retained plan or mutation here.
    public func check(commandsJSON: String, profile: String = "editac.core") async throws {
        guard let view, let revision = view.sessionSnapshot?.revision else {
            throw NativeCommandFailure.disabled(.unavailableSession)
        }
        try validatePayload(commandsJSON, profile: profile)
        let id = UUID()
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            checks[id] = c
            do { try view.session.submit(.commandCheck(revision: revision, json: commandsJSON,
                        origin: "appkit-command", now: now())) { [weak self] result in
                self?.checks.removeValue(forKey: id)?.resume(with: result.map { _ in () }.mapError { $0 as Error })
            } } catch { checks.removeValue(forKey: id)?.resume(throwing: error) }
        }
    }

    /// Structural/profile/extension presenters use the portable EditorCommand[]
    /// wire format, including this Session's anchor tokens. No native catalog copy.
    public func perform(commandsJSON: String, profile: String = "editac.core", revision: Data? = nil) {
        let state = availability(.serviceReplacement)
        guard state == .enabled, let current = view?.sessionSnapshot?.revision else {
            finish(.failure(.disabled(state))); return
        }
        do {
            try validatePayload(commandsJSON, profile: profile)
            execute(.commandBatch(revision: revision ?? current, json: commandsJSON,
                                  origin: "appkit-command", now: now()))
        } catch { finish(.failure(error as? NativeCommandFailure ?? .invalidCommand)) }
    }
    private func validatePayload(_ json: String, profile: String) throws {
        guard profileAvailability(profile)?.available == true,
              let data = json.data(using: .utf8),
              let values = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              !values.isEmpty, values.count <= 128 else { throw NativeCommandFailure.invalidCommand }
        for value in values {
            guard let id = value["type"] as? String,
                  let route = catalog?.routes.first(where: { $0.id == id }), route.available, route.canPrepare else {
                throw NativeCommandFailure.disabled(.unavailablePort)
            }
        }
    }
    private func execute(_ request: NativeSessionRequest) {
        guard let view else { return }
        isPending = true; view.textView.isEditable = false; refreshControls()
        do { try view.session.submit(request) { [weak self] result in self?.refresh(after: result) } }
        catch { refresh(after: .failure(error as? NativeSessionFailure ?? .unexpected(String(describing: error)))) }
    }

    // A read is a FIFO barrier and projects the authoritative post-history state,
    // including rejection/permission changes. Native UndoManager is never used.
    private func refresh(after result: Result<NativeSessionResponse, NativeSessionFailure>) {
        guard let view, !view.isDisposed else { return }
        do {
            // Structural planners can invalidate a retained incremental cursor.
            // Rebootstrap from the same Session, retaining stable native node
            // identities; never leave an accepted command behind a stale view.
            if view.projectionFailure != nil { try view.session.submit(.resyncProjection) }
            try view.session.submit(.read(now: now())) { [weak self, weak view] refreshed in
                guard let self, let view, !view.isDisposed else { return }
                self.isPending = false
                view.textView.isEditable = view.sessionSnapshot?.canApply == true && view.projectionFailure == nil
                if case let .success(.inputCommitted(_, node, caret)) = result,
                   let projected = view.projection.nodes.first(where: { $0.id == node }),
                   let target = try? view.projection.capture(
                    range: NSRange(location: projected.range.location + Int(caret), length: 0),
                    backwards: false, affinity: .downstream) {
                    try? view.projection.select(target)
                }
                guard view.projectionFailure == nil else {
                    self.finish(.failure(.session(.unexpected("Command projection unavailable: \(String(describing: view.projectionFailure))"))))
                    return
                }
                switch (result, refreshed) {
                case let (.failure(error), _), let (_, .failure(error)): self.finish(.failure(.session(error)))
                default: self.finish(.success(()))
                }
            }
        } catch {
            isPending = false
            view.textView.isEditable = false
            finish(.failure(.session(error as? NativeSessionFailure ?? .unexpected(String(describing: error)))))
        }
    }

    /// Capture before invoking a prepared host Service. Its eventual completion
    /// uses the input owner's single-use anchors, never the latest caret.
    public func captureService(range: NSRange) async throws -> NativeReplacementTarget {
        let state = availability(.serviceReplacement)
        guard state == .enabled, let view else { throw NativeCommandFailure.disabled(state) }
        return try await view.composition.captureReplacement(range: range)
    }
    public func completeService(_ target: NativeReplacementTarget, text: String) {
        guard let view else { return }
        // Focus may change while a service is running; completion belongs to its
        // captured view, not whichever responder is now focused. Rust revalidates.
        guard !view.isDisposed, !isPending else { view.composition.cancelReplacement(target); return }
        view.composition.replace(target, with: text)
    }
    public func cancelService(_ target: NativeReplacementTarget) { view?.composition.cancelReplacement(target) }
    private func finish(_ result: Result<Void, NativeCommandFailure>) {
        refreshControls()
        if case let .failure(error) = result { lastFailure = error } else { lastFailure = nil }
        onResult?(result)
    }
    func dispose() {
        for continuation in checks.values { continuation.resume(throwing: NativeSessionFailure.disposed) }
        checks.removeAll(); targetResults.removeAll(); validating.removeAll()
        isPending = false; find = nil; transfer = nil; catalog = nil; history = nil; onResult = nil; refreshControls()
        notifications.removeAll()
    }
}

@MainActor
private final class WeakNativeCommandButton {
    weak var value: NativeCommandButton?
    init(_ value: NativeCommandButton) { self.value = value }
}
private final class NativeCommandNotifications: @unchecked Sendable {
    var tokens: [NSObjectProtocol] = []
    func removeAll() {
        for token in tokens { NotificationCenter.default.removeObserver(token) }
        tokens = []
    }
    deinit { removeAll() }
}

/// A native action control with no independent mutation or history state.
@MainActor
public final class NativeCommandButton: NSButton {
    fileprivate let command: NativeCommand
    private weak var owner: NativeCommands?
    fileprivate init(command: NativeCommand, title: String, owner: NativeCommands) {
        self.command = command; self.owner = owner
        super.init(frame: .zero)
        self.title = title; target = self; action = #selector(invoke(_:))
        bezelStyle = .rounded
    }
    @objc private func invoke(_ sender: Any?) { owner?.perform(command) }
    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("Use commands.makeButton") }
}
