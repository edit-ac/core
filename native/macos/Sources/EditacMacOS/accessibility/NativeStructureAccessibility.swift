import AppKit

/// AppKit accessibility objects reference the live controls, never a second
/// semantic model. Reconciliation preserves surviving coordinate identities.
@MainActor
final class NativeAccessibleTable {
    weak var table: NativeTableView?
    private(set) var rows: [NSAccessibilityElement] = []
    private(set) var columns: [NSAccessibilityElement] = []
    private var cells: [NativeCellCoordinate: NativeAccessibleCell] = [:]
    var headers: [NSAccessibilityElement] {
        ordered.filter { $0.control?.isHeaderCell == true }
    }
    private var ordered: [NativeAccessibleCell] {
        cells.keys.sorted { ($0.row, $0.column) < ($1.row, $1.column) }.compactMap { cells[$0] }
    }
    func refresh() {
        guard let table else { return }
        func groups(_ existing: [NSAccessibilityElement], count: Int, role: NSAccessibility.Role) -> [NSAccessibilityElement] {
            (0..<count).map { index in
                let element = index < existing.count ? existing[index] : NativeAccessibleTableGroup()
                element.setAccessibilityRole(role); element.setAccessibilityParent(table)
                element.setAccessibilityIndex(index)
                element.setAccessibilityLabel("\(role == .row ? "Row" : "Column") \(index + 1)")
                return element
            }
        }
        for element in Array(rows.dropFirst(table.rowCount)) + Array(columns.dropFirst(table.columnCount)) {
            element.setAccessibilityChildren([]); element.setAccessibilityParent(nil)
        }
        rows = groups(rows, count: table.rowCount, role: .row)
        columns = groups(columns, count: table.columnCount, role: .column)
        for (coordinate, old) in cells where table.cells[coordinate] == nil { old.detach() }
        cells = table.cells.mapValues { control in
            let element = cells[control.coordinate] ?? NativeAccessibleCell()
            element.control = control; element.table = table
            element.setAccessibilityLabel(control.accessibilityLabel())
            element.setAccessibilityRole(.cell)
            element.setAccessibilityParent(rows[control.coordinate.row])
            control.setAccessibilityParent(element)
            return element
        }
        for (index, row) in rows.enumerated() {
            row.setAccessibilityChildren(ordered.filter { $0.control?.coordinate.row == index })
        }
        for (index, column) in columns.enumerated() {
            column.setAccessibilityChildren(ordered.filter { element in
                guard let c = element.control else { return false }
                return index >= c.coordinate.column && index < c.coordinate.column + c.columnSpan
            })
        }
    }
    func cell(column: Int, row: Int) -> NativeAccessibleCell? {
        guard let table, column >= 0, row >= 0, column < table.columnCount, row < table.rowCount else { return nil }
        return ordered.first { element in
            guard let c = element.control else { return false }
            return (c.coordinate.row..<(c.coordinate.row + c.rowSpan)).contains(row)
                && (c.coordinate.column..<(c.coordinate.column + c.columnSpan)).contains(column)
        }
    }
    func dispose() {
        cells.values.forEach { $0.detach() }
        for element in rows + columns { element.setAccessibilityChildren([]); element.setAccessibilityParent(nil) }
        cells.removeAll(); rows.removeAll(); columns.removeAll()
    }
}

@MainActor
private final class NativeAccessibleTableGroup: NSAccessibilityElement {
    override func accessibilityFrame() -> NSRect {
        (accessibilityChildren() ?? []).compactMap { $0 as? NativeAccessibleCell }
            .reduce(NSRect.null) { $0.union($1.accessibilityFrame()) }
    }
}

@MainActor
final class NativeAccessibleCell: NSAccessibilityElement {
    weak var control: NativeTableCellView?
    weak var table: NativeTableView?
    override func accessibilityColumnHeaderUIElements() -> [Any]? {
        guard let control, let table else { return [] }
        let range = control.coordinate.column..<(control.coordinate.column + control.columnSpan)
        return table.accessibleStructure.headers.filter { header in
            guard let cell = header as? NativeAccessibleCell, let other = cell.control, cell !== self else { return false }
            return range.overlaps(other.coordinate.column..<(other.coordinate.column + other.columnSpan))
        }
    }
    override func accessibilityChildren() -> [Any]? { control.map { [$0] } ?? [] }
    override func accessibilityRowIndexRange() -> NSRange {
        control.map { NSRange(location: $0.coordinate.row, length: $0.rowSpan) } ?? NSRange(location: NSNotFound, length: 0)
    }
    override func accessibilityColumnIndexRange() -> NSRange {
        control.map { NSRange(location: $0.coordinate.column, length: $0.columnSpan) } ?? NSRange(location: NSNotFound, length: 0)
    }
    override func accessibilityFrame() -> NSRect { control?.accessibilityFrame() ?? .zero }
    override func accessibilityPerformPress() -> Bool { control?.accessibilityPerformPress() ?? false }
    override func isAccessibilityEnabled() -> Bool { control?.window != nil }
    func detach() { control?.setAccessibilityParent(nil); control = nil; table = nil; setAccessibilityParent(nil) }
}

/// Explicit pointer-free routes available from the native text's AX actions.
/// Announcements are coalesced per main-queue turn and bounded to 256 characters.
@MainActor
public final class NativeStructureAccessibility {
    private weak var view: NativeEditorView?
    private var disposed = false
    private var scheduled = false
    public private(set) var lastAnnouncement: String?
    public private(set) var announcementCount = 0
    init(view: NativeEditorView) { self.view = view }

    private var controls: [NSView] {
        guard let view, !disposed, !view.isDisposed, view.projectionFailure == nil else { return [] }
        return view.projection.nodes.flatMap { node -> [NSView] in
            if let table = view.projection.tableViews[node.id] {
                return table.cells.values.sorted { ($0.coordinate.row, $0.coordinate.column) < ($1.coordinate.row, $1.coordinate.column) }
            }
            if let atom = view.attachments.views[node.id] { return [atom.selectButton] }
            if let atom = view.extensions.views[node.id] { return [atom.selectButton] }
            return []
        }
    }
    public var actions: [NSAccessibilityCustomAction] {
        guard !controls.isEmpty else { return [] }
        return [("Next structure", 1), ("Previous structure", -1), ("Return to editor", 0)].map { name, direction in
            NSAccessibilityCustomAction(name: name) { [weak self] in
                MainActor.assumeIsolated { self?.focus(direction: direction) ?? false }
            }
        }
    }
    @discardableResult
    public func focus(direction: Int) -> Bool {
        guard let view, !disposed, !view.isDisposed, view.projectionFailure == nil,
              let window = view.window else { return false }
        let controls = controls
        guard !controls.isEmpty || direction == 0 else { return false }
        let responder = window.firstResponder as? NSView
        let index = controls.firstIndex { control in
            if control === responder { return true }
            // A group action may move focus from its select button into another
            // child control; that remains the same structure navigation stop.
            if let group = control.superview, group is NativeAttachmentView || group is NativeExtensionView {
                return responder?.isDescendant(of: group) == true
            }
            return false
        }
        let next = index.map { $0 + (direction > 0 ? 1 : -1) } ?? (direction > 0 ? 0 : controls.count - 1)
        let target = direction == 0 || !controls.indices.contains(next) ? view.textView : controls[next]
        guard window.makeFirstResponder(target) else { return false }
        view.commands.refreshControls()
        target.scrollToVisible(target.bounds)
        NSAccessibility.post(element: target, notification: .focusedUIElementChanged)
        refreshAnnouncement()
        return true
    }
    func refresh() { refreshAnnouncement() }
    func refreshAnnouncement() {
        guard !disposed, !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled = false
            guard !self.disposed, let view = self.view, !view.isDisposed,
                  view.projectionFailure == nil, let responder = view.window?.firstResponder as? NSView else { return }
            var message: String?
            if let cell = responder as? NativeTableCellView { message = cell.accessibilityLabel() }
            for atom in view.attachments.views.values where responder.isDescendant(of: atom) {
                message = (atom.accessibilityLabel() ?? "Attachment") + ". " + atom.status.stringValue
            }
            for atom in view.extensions.views.values where responder.isDescendant(of: atom) {
                message = atom.accessibilityLabel()
            }
            guard let message else { return }
            let bounded = String(message.prefix(256))
            guard bounded != self.lastAnnouncement else { return }
            self.lastAnnouncement = bounded; self.announcementCount += 1
            NSAccessibility.post(element: view, notification: .announcementRequested,
                userInfo: [.announcement: bounded, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        }
    }
    static func buttonActions(in group: NSView, buttons: [NSButton]) -> [NSAccessibilityCustomAction] {
        buttons.filter { $0.isEnabled && !$0.isHidden }.map { button in
            NSAccessibilityCustomAction(name: button.title) { [weak button, weak group] in
                MainActor.assumeIsolated {
                    guard let button, let group, group.window != nil,
                          button.isDescendant(of: group), button.isEnabled, !button.isHidden else { return false }
                    button.performClick(nil); return true
                }
            }
        }
    }
    func dispose() { disposed = true; lastAnnouncement = nil }
}
