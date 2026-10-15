import AppKit
import EditacMacOS

/// Deterministic AppKit feasibility fixture, never a document or session model.
/// Editing is enabled only here. Production still requires shared admission.
@MainActor
public final class ControlCandidateProbe: NSView, NSTextViewDelegate {
    public let editor: NativeToolkitFixture
    public let grid: NSGridView
    public let cells: [NativeToolkitFixture]
    public let atomSource: NSTextField
    public let atomRange = NSRange(location: 7, length: 1)
    public private(set) var editProposals: [NSRange] = []
    public private(set) var textChangeCount = 0
    public private(set) var selectionChangeCount = 0
    public var acceptsEdits = true

    public override init(frame frameRect: NSRect) {
        editor = NativeToolkitFixture(frame: NSRect(x: 0, y: 170, width: 600, height: 130))
        cells = (0..<4).map { _ in
            NativeToolkitFixture(frame: NSRect(x: 0, y: 0, width: 240, height: 60))
        }
        grid = NSGridView(views: [[cells[0], cells[1]], [cells[2], cells[3]]])
        atomSource = NSTextField(string: "x²")
        super.init(frame: frameRect)
        editor.textView.isEditable = true
        editor.textView.delegate = self
        editor.textView.font = .systemFont(ofSize: 16)
        let text = NSMutableAttributedString(string: "Before ")
        let attachment = NSTextAttachment()
        attachment.attachmentCell = NSTextAttachmentCell(textCell: "x²")
        text.append(NSAttributedString(attachment: attachment))
        text.append(NSAttributedString(string: " after"))
        editor.textView.textStorage!.setAttributedString(text)
        addSubview(editor)
        grid.frame = NSRect(x: 0, y: 0, width: 600, height: 150)
        grid.rowSpacing = 8
        grid.columnSpacing = 8
        addSubview(grid)
        for (index, cell) in cells.enumerated() {
            cell.textView.isEditable = true
            cell.textView.delegate = self
            cell.textView.string = "Cell \(index)"
            cell.textView.setAccessibilityLabel("Probe cell \(index)")
            cell.heightAnchor.constraint(equalToConstant: 60).isActive = true
            cell.widthAnchor.constraint(equalToConstant: 240).isActive = true
        }
        atomSource.isEditable = true
        atomSource.isSelectable = true
        atomSource.setAccessibilityLabel("Probe atom source")
        // Real native child over the attachment, not image/source-only editing.
        editor.textView.addSubview(atomSource)
        cells[0].textView.nextKeyView = cells[1].textView
        cells[1].textView.nextKeyView = cells[2].textView
        cells[2].textView.nextKeyView = cells[3].textView
        cells[3].textView.nextKeyView = atomSource
    }

    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    /// Probe-only geometry for the fixed attachment range; production maps stable
    /// IDs/ranges on every patch/scroll and disposes child controls in later gates.
    @discardableResult
    public func positionAtomControl() -> NSRect {
        let view = editor.textView
        let manager = view.layoutManager!
        let container = view.textContainer!
        manager.ensureLayout(for: container)
        let glyphs = manager.glyphRange(forCharacterRange: atomRange, actualCharacterRange: nil)
        var rect = manager.boundingRect(forGlyphRange: glyphs, in: container)
        rect.origin.x += view.textContainerOrigin.x
        rect.origin.y += view.textContainerOrigin.y
        atomSource.frame = NSRect(x: rect.minX, y: rect.minY, width: max(80, rect.width), height: 24)
        return rect
    }

    public func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange,
                         replacementString: String?) -> Bool {
        editProposals.append(affectedCharRange)
        return acceptsEdits
    }

    public func textDidChange(_ notification: Notification) { textChangeCount += 1 }
    public func textViewDidChangeSelection(_ notification: Notification) { selectionChangeCount += 1 }
}

/// Raw AppKit candidate, deliberately independent of the Session-bound input
/// subclass. Production composition is qualified by the composition suite; this
/// earlier feasibility fixture must continue to exercise the toolkit itself.
@MainActor
public final class NativeToolkitFixture: NSView {
    public let textView: NSTextView
    public let scrollView: NSScrollView
    public override init(frame: NSRect) {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: frame.width, height: .greatestFiniteMagnitude))
        storage.addLayoutManager(layout); layout.addTextContainer(container)
        textView = NSTextView(frame: NSRect(origin: .zero, size: frame.size), textContainer: container)
        scrollView = NSScrollView(frame: NSRect(origin: .zero, size: frame.size))
        super.init(frame: frame)
        textView.isRichText = true; textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false; textView.allowsUndo = false
        textView.autoresizingMask = [.width]; container.widthTracksTextView = true
        scrollView.documentView = textView; scrollView.autoresizingMask = [.width, .height]
        addSubview(scrollView)
    }
    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
}
