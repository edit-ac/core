import AppKit

/// Native control with an owned shared-session executor and a text-only projection.
/// Rich projection and native editing remain subsequent roadmap work.
@MainActor
public final class NativeEditorView: NSView {
    public let session = NativeSessionExecutor()
    public private(set) var sessionSnapshot: NativeSessionRead?
    public private(set) var sessionFailure: NativeSessionFailure?
    public private(set) var sessionDeliveryCount = 0
    public private(set) var isDisposed = false
    public private(set) lazy var projection = NativeTextProjection(textView: textView)
    public private(set) var projectionFailure: NativeProjectionFailure?
    public let scrollView: NSScrollView
    public let textView: NSTextView

    public override init(frame frameRect: NSRect) {
        let localFrame = NSRect(origin: .zero, size: frameRect.size)
        scrollView = NSScrollView(frame: localFrame)
        // Explicit TextKit 1 graph: no implicit TextKit 2 compatibility fallback.
        // DSK-1.2 probes this same path for composition and native child views.
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(
            width: localFrame.width, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        textView = NSTextView(frame: localFrame, textContainer: container)
        super.init(frame: frameRect)

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
        session.onResult = { [weak self] result in
            guard let self, !self.isDisposed else { return }
            self.sessionDeliveryCount += 1
            switch result {
            case let .success(.snapshot(snapshot)):
                self.sessionSnapshot = snapshot
                self.sessionFailure = nil
                do {
                    try self.projection.apply(snapshot)
                    self.projectionFailure = nil
                    self.textView.setAccessibilityLabel("Editor (text projection)")
                } catch let failure as NativeProjectionFailure {
                    self.projectionFailure = failure
                    self.textView.setAccessibilityLabel("Editor (projection unavailable)")
                } catch { preconditionFailure("Unexpected projection failure: \(error)") }
            case let .failure(error): self.sessionFailure = error
            default: break
            }
        }
    }

    /// The embedding host calls this when its editor/document is closed.
    public func dispose(completion: @escaping @MainActor @Sendable () -> Void = {}) {
        isDisposed = true
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
