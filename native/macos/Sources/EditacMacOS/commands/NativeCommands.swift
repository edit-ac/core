import AppKit

public enum NativeCommand: String, Sendable, CaseIterable {
    case undo, redo, selectAll, copy, find, cut, paste, pastePlainText, structural, serviceReplacement
}
public enum NativeCommandAvailability: Equatable, Sendable {
    case enabled, unfocused, unavailableSession, busy, readOnly, unavailablePort
}
public enum NativeCommandFailure: Error {
    case disabled(NativeCommandAvailability)
    case session(NativeSessionFailure)
}

/// Responder admission only. Rust owns history, edits, permission and revision
/// validation. Transfer and structural commands stay unavailable until their
/// qualified shared ports are connected; no native semantic fallback is used.
@MainActor
public final class NativeCommands {
    private weak var view: NativeEditorView?
    private var buttons: [WeakNativeCommandButton] = []
    private let notifications = NativeCommandNotifications()
    public private(set) var isPending = false
    public var now: @MainActor () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1_000) }
    public var find: (@MainActor () -> Void)?
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
        buttons.removeAll { $0.value == nil }
        for box in buttons {
            guard let button = box.value else { continue }
            button.isEnabled = availability(button.command) == .enabled
        }
    }

    public func availability(_ command: NativeCommand) -> NativeCommandAvailability {
        guard let view, !view.isDisposed, view.projectionFailure == nil,
              view.sessionSnapshot?.revision != nil else { return .unavailableSession }
        guard view.window?.isKeyWindow == true, view.window?.firstResponder === view.textView else { return .unfocused }
        if command == .selectAll || command == .copy { return .enabled }
        if command == .find { return find == nil ? .unavailablePort : .enabled }
        guard !isPending, !view.input.isPending, !view.composition.isPending,
              !view.composition.isActive else { return .busy }
        guard view.sessionSnapshot?.canApply == true else { return .readOnly }
        switch command {
        case .undo, .redo:
            return view.sessionSnapshot?.canHistory == true ? .enabled : .readOnly
        case .serviceReplacement: return .enabled
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
        default: finish(.failure(.disabled(.unavailablePort)))
        }
    }

    // A read is a FIFO barrier and projects the authoritative post-history state,
    // including rejection/permission changes. Native UndoManager is never used.
    private func refresh(after result: Result<NativeSessionResponse, NativeSessionFailure>) {
        guard let view, !view.isDisposed else { return }
        do {
            try view.session.submit(.read(now: now())) { [weak self, weak view] refreshed in
                guard let self, let view, !view.isDisposed else { return }
                self.isPending = false
                view.textView.isEditable = view.sessionSnapshot?.canApply == true && view.projectionFailure == nil
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
        isPending = false; find = nil; onResult = nil; refreshControls()
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
