import AppKit

/// Embedding hosts retain this binding with the editor. All accepted mutations
/// already append through SQLite before acknowledgment; backgrounding is a status
/// refresh, not an invented flush or a remote-sync acknowledgment.
@MainActor
public final class NativeDocumentLifecycle {
    private weak var view: NativeEditorView?
    private let observations = NativeLifecycleObservers()
    public let statusLabel = NSTextField(labelWithString: "Document closed")
    public private(set) var status = NativeStorageStatus.closed
    public private(set) var isClosing = false
    public var onWindowClose: (@MainActor @Sendable (Result<Void, NativeSessionFailure>) -> Void)?

    init(view: NativeEditorView) {
        self.view = view
        statusLabel.setAccessibilityLabel("Local save status")
        view.session.onStorageStatus = { [weak self] status in
            guard let self else { return }
            self.status = status
            self.statusLabel.stringValue = status.label
            self.statusLabel.toolTip = status.label
            if status.snapshot?.recoveryRequired == true {
                self.view?.textView.isEditable = false
            }
        }
    }

    /// Does not replace the embedding application's window delegate. The host
    /// should invoke close before approving a document/window/application close;
    /// the will-close observation is a safety net for ordinary native teardown.
    public func bind(window: NSWindow, notifications: NotificationCenter = .default,
                     now: @escaping @MainActor @Sendable () -> UInt64) {
        unbind()
        observations.tokens.append(notifications.addObserver(forName: NSWindow.willCloseNotification,
            object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close { [weak self] result in self?.onWindowClose?(result) } }
            })
        observations.tokens.append(notifications.addObserver(forName: NSApplication.didResignActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { try? self?.refresh(now: now()) }
            })
        observations.center = notifications
    }
    public func unbind() {
        observations.removeAll()
    }

    public func refresh(now: UInt64) throws {
        guard let view, !view.isDisposed else { throw NativeSessionFailure.disposed }
        try view.session.submit(.read(now: now))
    }
    public func recover(completion: @escaping NativeSessionExecutor.Completion) throws {
        guard let view, !view.isDisposed else { throw NativeSessionFailure.disposed }
        try view.session.submit(.recover, completion: completion)
    }
    public func exportRecovery(completion: @escaping NativeSessionExecutor.Completion) throws {
        guard let view, !view.isDisposed else { throw NativeSessionFailure.disposed }
        try view.session.submit(.recoveryExport, completion: completion)
    }

    /// The callback is after accepted work and actual Rust/SQLite release. A
    /// rejected close retains the Session, unsaved recovery export and retry path.
    public func close(completion: @escaping @MainActor @Sendable (Result<Void, NativeSessionFailure>) -> Void) {
        guard let view else { completion(.failure(.disposed)); return }
        if view.isDisposed { completion(.success(())); return }
        guard !isClosing else { completion(.failure(.closing)); return }
        isClosing = true
        view.textView.isEditable = false
        do {
            try view.session.closeDurably { [weak self, weak view] result in
                guard let self else { completion(.failure(.disposed)); return }
                switch result {
                case let .failure(error):
                    self.isClosing = false
                    view?.textView.isEditable = view?.sessionSnapshot?.canApply == true && self.status.snapshot?.recoveryRequired != true
                    completion(.failure(error))
                case .success:
                    self.unbind()
                    guard let view else { completion(.failure(.disposed)); return }
                    view.dispose { completion(.success(())) }
                }
            }
        } catch {
            isClosing = false
            completion(.failure(error as? NativeSessionFailure ?? .unexpected(String(describing: error))))
        }
    }
    func dispose() { unbind() }
}

private final class NativeLifecycleObservers: @unchecked Sendable {
    var center = NotificationCenter.default
    var tokens: [NSObjectProtocol] = []
    func removeAll() {
        for token in tokens { center.removeObserver(token) }
        tokens = []
    }
    deinit { removeAll() }
}
