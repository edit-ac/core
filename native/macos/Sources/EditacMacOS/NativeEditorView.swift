import AppKit

/// Native bootstrap surface. Shared-session binding is delivered by DSK-1.3.
/// Until then, the empty projection permits selection but admits no mutations.
@MainActor
public final class NativeEditorView: NSView {
    public let scrollView: NSScrollView
    public let textView: NSTextView

    public override init(frame frameRect: NSRect) {
        let localFrame = NSRect(origin: .zero, size: frameRect.size)
        scrollView = NSScrollView(frame: localFrame)
        textView = NSTextView(frame: localFrame)
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
    }

    @available(*, unavailable)
    public required init?(coder: NSCoder) {
        fatalError("Use init(frame:)")
    }
}
