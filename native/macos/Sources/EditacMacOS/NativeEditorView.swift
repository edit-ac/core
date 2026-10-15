import AppKit

/// Native control projected from the owned shared Session. Committed input
/// passes through shared preparation and durable admission.
@MainActor
public final class NativeEditorView: NSView {
    public let session = NativeSessionExecutor()
    public private(set) lazy var accessibility = NativeTextAccessibility(view: self)
    public private(set) lazy var storage = NativeDocumentLifecycle(view: self)
    public private(set) var sessionSnapshot: NativeSessionRead?
    public private(set) var sessionFailure: NativeSessionFailure?
    public private(set) var sessionDeliveryCount = 0
    public private(set) var isDisposed = false
    public private(set) lazy var projection = NativeTextProjection(textView: textView)
    public private(set) var projectionFailure: NativeProjectionFailure?
    public private(set) var projectionSessionFailure: NativeSessionFailure?
    private var selectionGeneration: UInt64 = 0
    private var selectionWaiters: [UUID: CheckedContinuation<NativeSessionResponse, Error>] = [:]
    public private(set) lazy var commands = NativeCommands(view: self)
    public private(set) lazy var attachments = NativeAttachments(view: self)
    public private(set) lazy var tables = NativeTableEditing(view: self)
    public private(set) lazy var input = NativeCommittedInput(view: self)
    public private(set) lazy var composition = NativeComposition(view: self)
    var applyingProjection = false
    public let scrollView: NSScrollView
    public let textView: NSTextView

    public override init(frame frameRect: NSRect) {
        let localFrame = NSRect(origin: .zero, size: frameRect.size)
        scrollView = NSScrollView(frame: localFrame)
        // Explicit TextKit 1 graph: no implicit TextKit 2 compatibility fallback.
        // DSK-1.2 probes this same path for composition and native child views.
        let storage = NSTextStorage()
        let layout = NativeStyledLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(
            width: localFrame.width, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        textView = NativeInputTextView(frame: localFrame, textContainer: container)
        super.init(frame: frameRect)
        (textView as? NativeInputTextView)?.editor = self
        textView.delegate = input

        textView.isRichText = true
        textView.isEditable = false
        textView.isSelectable = true
        textView.allowsUndo = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude,
                                  height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityLabel("Editor (session unavailable)")
        scrollView.hasVerticalScroller = true
        scrollView.documentView = textView
        scrollView.autoresizingMask = [.width, .height]
        addSubview(scrollView)
        scrollView.frame = bounds
        _ = self.storage
        session.onProjection = { [weak self] result in
            guard let self, !self.isDisposed else { return }
            guard !self.composition.isActive else { return }
            self.composition.restoreDisplay()
            self.applyingProjection = true
            defer {
                self.applyingProjection = false
                self.textView.isEditable = self.projectionFailure == nil && !self.input.isPending && !self.composition.isPending && !self.commands.isPending
            }
            guard case let .success(update) = result else {
                if case let .failure(error) = result { self.projectionSessionFailure = error }
                self.attachments.cancelAll()
                self.projectionFailure = .unavailableRevision
                self.projection.revision = nil
                self.projection.invalidateAnchoredSelection()
                self.textView.setAccessibilityLabel("Editor (projection unavailable)")
                return
            }
            self.projectionSessionFailure = nil
            do {
                let previousText = self.textView.string
                try self.projection.apply(update)
                if let catalog = update.commandCatalog, let history = update.history {
                    self.commands.observe(catalog: catalog, history: history)
                }
                self.projectionFailure = nil
                try self.attachments.reconcile()
                self.textView.setAccessibilityLabel("Editor (native projection)")
                if previousText != self.textView.string {
                    NSAccessibility.post(element: self.textView, notification: .valueChanged)
                }
            } catch {
                self.attachments.cancelAll()
                self.projectionFailure = error as? NativeProjectionFailure ?? .malformedRichProjection
                self.projection.revision = nil
                self.projection.invalidateAnchoredSelection()
                self.textView.setAccessibilityLabel("Editor (projection unavailable)")
            }
        }
        session.onResult = { [weak self] result in
            guard let self, !self.isDisposed else { return }
            defer { self.projection.refreshTypingStyle(); self.commands.refreshControls(); self.tables.refresh() }
            self.sessionDeliveryCount += 1
            switch result {
            case let .success(.snapshot(snapshot)), let .success(.inputCommitted(snapshot, _, _)),
                 let .success(.inputRestored(snapshot, _, _, _)):
                self.sessionSnapshot = snapshot
                self.sessionFailure = nil
                if !snapshot.canApply { self.composition.cancel() }
                self.textView.isEditable = snapshot.canApply && self.projectionFailure == nil && !self.input.isPending && !self.composition.isPending && !self.commands.isPending

            case let .failure(error): self.sessionFailure = error
            default: break
            }
        }
    }

    /// Capture the current native directional range on the serialized shared
    /// Session before asynchronous work. A late result cannot select a new revision.
    public func select(range: NSRange, backwards: Bool,
                       affinity: NSSelectionAffinity) async throws {
        let target = try projection.capture(range: range, backwards: backwards, affinity: affinity)
        let inputs = try projection.anchorInputs(for: target)
        selectionGeneration += 1
        let generation = selectionGeneration
        let id = UUID()
        let response: NativeSessionResponse = try await withCheckedThrowingContinuation { continuation in
            selectionWaiters[id] = continuation
            do {
                try session.submit(.retainSelection(revision: target.revision, inputs: inputs)) { [weak self] result in
                    self?.selectionWaiters.removeValue(forKey: id)?.resume(with: result.mapError { $0 as Error })
                }
            } catch { selectionWaiters.removeValue(forKey: id)?.resume(throwing: error) }
        }
        guard !isDisposed else { throw NativeProjectionFailure.disposed }
        guard generation == selectionGeneration else { throw NativeProjectionFailure.staleTarget }
        guard case .anchors = response else { throw NativeProjectionFailure.staleTarget }
        do {
            try projection.select(target)
            projection.anchoredSelection = true
        } catch {
            try? session.submit(.releaseSelection)
            throw error
        }
    }

    /// The embedding host calls this when its editor/document is closed.
    public func dispose(completion: @escaping @MainActor @Sendable () -> Void = {}) {
        isDisposed = true
        storage.dispose()
        attachments.dispose()
        commands.dispose()
        composition.dispose()
        input.dispose()
        textView.delegate = nil
        selectionGeneration += 1
        for waiter in selectionWaiters.values { waiter.resume(throwing: NativeProjectionFailure.disposed) }
        selectionWaiters = [:]
        sessionSnapshot = nil
        sessionFailure = nil
        textView.isEditable = false
        projection.dispose()
        session.dispose(completion: completion)
    }

    @available(*, unavailable)
    public required init?(coder: NSCoder) {
        fatalError("Use init(frame:)")
    }
}
