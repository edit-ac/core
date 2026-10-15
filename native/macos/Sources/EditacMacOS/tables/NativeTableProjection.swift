import AppKit

public struct NativeCellCoordinate: Hashable, Sendable {
    public let row: Int
    public let column: Int
    public init(row: Int, column: Int) { self.row = row; self.column = column }
}

/// Validated presentation of the shared inert tuple. No writable semantic state.
struct NativeTableDescriptor {
    struct Cell {
        let coordinate: NativeCellCoordinate
        let rowSpan: Int
        let columnSpan: Int
        let header: Bool
        let paragraphs: [[String: Any]]
    }
    let tuple: [Any]
    let alignments: [String]
    let rowCount: Int
    let cells: [Cell]

    init(_ tuple: [Any]) throws {
        func invalid() -> NativeProjectionFailure { .malformedRichProjection }
        guard tuple.count == 3, tuple[0] as? String == "module:editac.table",
              let version = tuple[1] as? Int, [1, 2].contains(version),
              let data = tuple[2] as? [String: Any],
              let alignments = data["alignments"] as? [String],
              !alignments.isEmpty, alignments.count <= 32,
              alignments.allSatisfy({ ["none", "left", "center", "right"].contains($0) }),
              let rows = data["rows"] as? [[Any]], !rows.isEmpty, rows.count <= 128,
              let source = data["source"] as? String, source.utf8.count <= 1_048_576 else { throw invalid() }
        var covered = Set<NativeCellCoordinate>()
        var cells: [Cell] = []
        var paragraphCount = 0, runCount = 0
        for (r, row) in rows.enumerated() {
            guard row.count == alignments.count else { throw invalid() }
            for (c, value) in row.enumerated() {
                let coordinate = NativeCellCoordinate(row: r, column: c)
                if covered.contains(coordinate) {
                    guard value is NSNull else { throw invalid() }; continue
                }
                let paragraphs: [[String: Any]], height: Int, width: Int, header: Bool
                if version == 1 {
                    guard let runs = value as? [Any] else { throw invalid() }
                    paragraphs = [["style": ["paragraph"], "runs": runs]]
                    height = 1; width = 1; header = r == 0
                } else {
                    guard let cell = value as? [String: Any],
                          let p = cell["paragraphs"] as? [[String: Any]], !p.isEmpty,
                          let h = cell["rowSpan"] as? Int, let w = cell["columnSpan"] as? Int,
                          let isHeader = cell["header"] as? Bool else { throw invalid() }
                    paragraphs = p; height = h; width = w; header = isHeader
                }
                guard height > 0, width > 0, height <= rows.count - r, width <= row.count - c else { throw invalid() }
                for row in r..<(r + height) {
                    for column in c..<(c + width) {
                        guard covered.insert(.init(row: row, column: column)).inserted else { throw invalid() }
                    }
                }
                paragraphCount += paragraphs.count
                for p in paragraphs {
                    guard let style = p["style"] as? [Any], let tag = style.first as? String,
                          ["paragraph", "heading", "code"].contains(tag),
                          let runs = p["runs"] as? [[Any]],
                          runs.allSatisfy({ $0.count == 2 && $0[0] is String && $0[1] is [[Any]] }) else { throw invalid() }
                    runCount += runs.count
                }
                cells.append(Cell(coordinate: coordinate, rowSpan: height, columnSpan: width,
                                  header: header, paragraphs: paragraphs))
            }
        }
        guard paragraphCount <= 1024, runCount <= 1024 else { throw invalid() }
        self.tuple = tuple; self.alignments = alignments; rowCount = rows.count; self.cells = cells
    }
}

/// Real native cell control. Edits remain disabled until the shared command
/// adapter in DSK-1.10 is installed; no native-only history or mutation escape.
@MainActor
public final class NativeTableCellView: NSTextView {
    public let coordinate: NativeCellCoordinate
    public internal(set) var rowSpan = 1
    public internal(set) var columnSpan = 1
    public internal(set) var isHeaderCell = false
    init(coordinate: NativeCellCoordinate) {
        self.coordinate = coordinate
        // Use NSTextView's designated initializer. Its frame-only convenience
        // initializer dynamically re-enters init(frame:textContainer:).
        let storage = NSTextStorage()
        let manager = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: 80, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(manager); manager.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false; isSelectable = true; isRichText = true; allowsUndo = false
        textContainerInset = NSSize(width: 6, height: 6)
        textContainer?.lineFragmentPadding = 0
        drawsBackground = true
        wantsLayer = true; layer?.borderWidth = 0.5; layer?.borderColor = NSColor.separatorColor.cgColor
    }
    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("Use coordinate") }
}

@MainActor
private final class TableCanvas: NSView { override var isFlipped: Bool { true } }

@MainActor
public final class NativeTableView: NSScrollView {
    public let nodeID: String
    public private(set) var cells: [NativeCellCoordinate: NativeTableCellView] = [:]
    public private(set) var sharedTuple: [Any] = []
    public private(set) var rowCount = 0
    public private(set) var columnCount = 0
    private let canvas = TableCanvas()
    private var descriptor: NativeTableDescriptor?
    private let styles = NativeStyleRegistry()
    init(nodeID: String) {
        self.nodeID = nodeID
        super.init(frame: .zero)
        documentView = canvas; hasHorizontalScroller = true; autohidesScrollers = true
        borderType = .noBorder
        setAccessibilityLabel("Table")
    }
    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("Use nodeID") }

    func update(_ descriptor: NativeTableDescriptor) throws {
        var next: [NativeCellCoordinate: NativeTableCellView] = [:]
        for cell in descriptor.cells {
            let control = cells[cell.coordinate] ?? NativeTableCellView(coordinate: cell.coordinate)
            control.rowSpan = cell.rowSpan; control.columnSpan = cell.columnSpan; control.isHeaderCell = cell.header
            let text = NSMutableAttributedString(string: "")
            for (index, paragraph) in cell.paragraphs.enumerated() {
                if index > 0 { text.append(NSAttributedString(string: "\n")) }
                let start = text.length
                // Adapt tuple runs to the one native style registry, preserving
                // the exact shared tuple above for roundtrip/diagnostics.
                let runs = (paragraph["runs"] as! [[Any]]).map { run -> [String: Any] in
                    var attributes: [String: Any] = [:]
                    for mark in run[1] as! [[Any]] {
                        if let tag = mark.first as? String {
                            attributes[tag] = tag == "link" ? mark.dropFirst().first : true
                        }
                    }
                    return ["text": run[0], "attributes": attributes]
                }
                let node = try RichProjectionNode(["id": nodeID, "kind": "block", "order": 0,
                    "runs": runs, "blockAttributes": paragraph["style"]!])
                text.append(NSAttributedString(string: node.text))
                let storage = NSTextStorage(attributedString: text.attributedSubstring(from: NSRange(location: start, length: text.length - start)))
                let range = NSRange(location: 0, length: storage.length)
                _ = styles.apply(node, nodes: [:], range: range, paragraphRange: range, storage: storage)
                let style = (storage.length > 0 ? storage.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle : nil)?.mutableCopy() as? NSMutableParagraphStyle ?? NSMutableParagraphStyle()
                switch descriptor.alignments[cell.coordinate.column] {
                case "center": style.alignment = .center
                case "right": style.alignment = .right
                default: style.alignment = .left
                }
                storage.addAttribute(.paragraphStyle, value: style, range: range)
                text.replaceCharacters(in: NSRange(location: start, length: text.length - start), with: storage)
            }
            if !control.attributedString().isEqual(to: text) { control.textStorage?.setAttributedString(text) }
            control.backgroundColor = cell.header ? .controlBackgroundColor : .textBackgroundColor
            control.setAccessibilityLabel("\(cell.header ? "Header" : "Cell") row \(cell.coordinate.row + 1), column \(cell.coordinate.column + 1)")
            if control.superview !== canvas { canvas.addSubview(control) }
            next[cell.coordinate] = control
        }
        for (key, old) in cells where next[key] == nil { old.removeFromSuperview() }
        cells = next; self.descriptor = descriptor; sharedTuple = descriptor.tuple
        rowCount = descriptor.rowCount; columnCount = descriptor.alignments.count
    }

    func fit(width: CGFloat) -> NSSize {
        guard let descriptor else { return .zero }
        let columnWidth = max(80, width / CGFloat(columnCount))
        var heights = Array(repeating: CGFloat(32), count: rowCount)
        for cell in descriptor.cells {
            let control = cells[cell.coordinate]!
            let w = columnWidth * CGFloat(cell.columnSpan)
            control.textContainer?.containerSize = NSSize(width: max(1, w - 12), height: .greatestFiniteMagnitude)
            control.layoutManager?.ensureLayout(for: control.textContainer!)
            let needed = (control.layoutManager?.usedRect(for: control.textContainer!).height ?? 20) + 12
            let each = ceil(needed / CGFloat(cell.rowSpan))
            for row in cell.coordinate.row..<(cell.coordinate.row + cell.rowSpan) { heights[row] = max(heights[row], each) }
        }
        for cell in descriptor.cells {
            cells[cell.coordinate]!.frame = NSRect(x: CGFloat(cell.coordinate.column) * columnWidth,
                y: heights.prefix(cell.coordinate.row).reduce(0, +), width: CGFloat(cell.columnSpan) * columnWidth,
                height: heights[cell.coordinate.row..<(cell.coordinate.row + cell.rowSpan)].reduce(0, +))
        }
        canvas.frame = NSRect(x: 0, y: 0, width: columnWidth * CGFloat(columnCount), height: heights.reduce(0, +))
        return NSSize(width: width, height: canvas.frame.height + (canvas.frame.width > width ? 16 : 0))
    }

    func dispose() {
        for cell in cells.values { cell.removeFromSuperview() }
        cells = [:]; descriptor = nil; sharedTuple = []; styles.dispose(); removeFromSuperview()
    }
}

@MainActor
final class NativeTableAttachmentCell: NSTextAttachmentCell {
    // TextKit reads this metric through a nonisolated AppKit callback. All
    // writes and layout are confined to the main thread by NativeTextProjection.
    nonisolated(unsafe) var projectedSize = NSSize(width: 80, height: 32)
    override func cellSize() -> NSSize { projectedSize }
    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {}
}

extension NativeTextProjection {
    func reconcileTables(_ descriptors: [String: NativeTableDescriptor]) throws {
        var next: [String: NativeTableView] = [:]
        for (id, descriptor) in descriptors {
            let table = tableViews[id] ?? NativeTableView(nodeID: id)
            try table.update(descriptor)
            if table.superview !== textView { textView.addSubview(table) }
            next[id] = table
        }
        for (id, old) in tableViews where next[id] == nil { old.dispose() }
        tableViews = next
        layoutTables()
    }

    /// Called after patches and native width changes. Child coordinates come
    /// from TextKit attachment geometry, so preceding edits and scrolling agree.
    public func layoutTables() {
        guard !disposed, !layingOutTables, !tableViews.isEmpty, let manager = textView.layoutManager,
              let container = textView.textContainer else { return }
        layingOutTables = true
        defer { layingOutTables = false }
        let width = max(80, container.containerSize.width - container.lineFragmentPadding * 2)
        // Install every metric first: changing a preceding attachment can move
        // all later glyphs. Positioning during that pass leaves stale frames.
        var sizes: [String: NSSize] = [:]
        for (id, table) in tableViews {
            guard let node = nodes.first(where: { $0.id == id }), let attachment = attachmentIdentities[id] else { continue }
            let size = table.fit(width: width)
            sizes[id] = size
            let cell = attachment.attachmentCell as? NativeTableAttachmentCell ?? NativeTableAttachmentCell(textCell: "")
            if cell.projectedSize != size {
                cell.projectedSize = size; attachment.attachmentCell = cell
                manager.invalidateLayout(forCharacterRange: node.range, actualCharacterRange: nil)
            }
        }
        manager.ensureLayout(for: container)
        for (id, table) in tableViews {
            guard let node = nodes.first(where: { $0.id == id }), let size = sizes[id] else { continue }
            let glyphs = manager.glyphRange(forCharacterRange: node.range, actualCharacterRange: nil)
            var rect = manager.boundingRect(forGlyphRange: glyphs, in: container)
            rect.origin.x += textView.textContainerOrigin.x; rect.origin.y += textView.textContainerOrigin.y
            table.frame = NSRect(origin: rect.origin, size: size)
        }
    }
}
