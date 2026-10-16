import AppKit

/// A separate native read-only surface. It has no Session, mutation callback,
/// history checkout, link activation or editable field.
@MainActor
final class NativeChangeReviewView: NSView {
    private final class ReviewTextView: NSTextView {
        override var undoManager: UndoManager? { nil }
        override func shouldChangeText(in affectedCharRange: NSRange, replacementString: String?) -> Bool { false }
        override func insertText(_ insertString: Any, replacementRange: NSRange) {}
        override func paste(_ sender: Any?) {}
        override func cut(_ sender: Any?) {}
        override func deleteBackward(_ sender: Any?) {}
        override func deleteForward(_ sender: Any?) {}
        override func setAccessibilityValue(_ accessibilityValue: Any?) {}
    }
    let title = NSTextField(labelWithString: "Change review")
    let status = NSTextField(labelWithString: "No revision loaded")
    let textView: NSTextView = ReviewTextView()
    let previous = NSButton(title: "Previous change", target: nil, action: nil)
    let next = NSButton(title: "Next change", target: nil, action: nil)
    private(set) var ranges: [NSRange] = []
    private(set) var selectedChange: Int?
    private(set) var presentation: NativeChangeReviewPresentation?
    private(set) var disposed = false
    private var currentScope: NativeChangeReviewScope?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(false)
        title.maximumNumberOfLines = 0; status.maximumNumberOfLines = 0
        textView.isEditable = false; textView.isSelectable = true
        textView.isRichText = false; textView.allowsUndo = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticDataDetectionEnabled = false
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.setAccessibilityLabel("Read-only change details")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.documentView = textView
        textView.isVerticallyResizable = true; textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]; textView.textContainer?.widthTracksTextView = true
        previous.target = self; previous.action = #selector(goPrevious)
        next.target = self; next.action = #selector(goNext)
        previous.setAccessibilityLabel("Previous change"); next.setAccessibilityLabel("Next change")
        let buttons = NSStackView(views: [previous, next]); buttons.orientation = .horizontal
        let stack = NSStackView(views: [title, status, buttons, scroll])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false; addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 40)
        ])
        updateButtons()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(_ value: NativeChangeReviewPresentation, current: NativeChangeReviewScope) {
        guard !disposed else { return }
        presentation = value; currentScope = current; selectedChange = nil; ranges = []
        title.stringValue = "Read-only review: \(value.beforeLabel) → \(value.afterLabel)\n\(value.representation)\nDocument: \(value.scope.document); epoch: \(value.scope.epoch); schema: \(value.scope.schema); profile: \(value.scope.profile)\n\(value.attribution.label)\nBefore hash: \(value.beforeHash)\nAfter hash: \(value.afterHash)"
        var content = ""
        for section in value.sections {
            let start = (content as NSString).length
            content += section.label + "\n" + section.text + "\n\n"
            ranges.append(NSRange(location: start, length: (content as NSString).length - start))
        }
        if value.sections.isEmpty { content = "No changes\n" }
        textView.string = content
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        updateStatus(); updateButtons()
    }

    func observeCurrentScope(_ value: NativeChangeReviewScope?) {
        guard !disposed else { return }
        currentScope = value; updateStatus()
    }

    @discardableResult func navigate(to index: Int) -> Bool {
        guard !disposed, ranges.indices.contains(index) else { return false }
        selectedChange = index
        textView.setSelectedRange(ranges[index]); textView.scrollRangeToVisible(ranges[index])
        window?.makeFirstResponder(textView)
        updateButtons()
        return true
    }
    @objc private func goNext() { _ = navigate(to: (selectedChange ?? -1) + 1) }
    @objc private func goPrevious() { _ = navigate(to: (selectedChange ?? ranges.count) - 1) }
    private func updateStatus() {
        guard let presentation else { return }
        if currentScope == nil { status.stringValue = "Current revision unavailable — historical review retained" }
        else if currentScope != presentation.scope { status.stringValue = "Stale revision — historical review retained; live document unchanged" }
        else { status.stringValue = "Current revision — read-only review" }
        status.setAccessibilityLabel(status.stringValue)
    }
    private func updateButtons() {
        previous.isEnabled = !disposed && !ranges.isEmpty && (selectedChange ?? ranges.count) > 0
        next.isEnabled = !disposed && !ranges.isEmpty && (selectedChange ?? -1) < ranges.count - 1
    }
    func dispose() {
        guard !disposed else { return }
        disposed = true; presentation = nil; currentScope = nil; ranges = []; selectedChange = nil
        title.stringValue = "Change review closed"; status.stringValue = "Disposed"
        textView.string = ""; previous.target = nil; next.target = nil; updateButtons()
    }
}
