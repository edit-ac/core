import AppKit

public enum NativeTableEditingFailure: Error, Equatable {
    case unavailable, staleTarget, unsupportedCell, invalidRange
}

/// Captured presentation data, never a second writable table model. Both the
/// revision and exact tuple travel to the shared compare/prepare/commit gate.
public struct NativeTableCellTarget {
    public let tableID: String
    public let coordinate: NativeCellCoordinate
    public let revision: Data
    fileprivate let tuple: Data
    fileprivate let text: String
}

public enum NativeTableStructureAction: String, Sendable, CaseIterable {
    case insertRow, deleteRow, insertColumn, deleteColumn
}

public struct NativeTableStructureTarget {
    public let tableID: String
    public let revision: Data
    fileprivate let tuple: Data
}

@MainActor
public final class NativeTableStructureButton: NSButton {
    weak var editing: NativeTableEditing?
    let tableID: String
    let operation: NativeTableStructureAction
    let index: Int
    init(editing: NativeTableEditing, tableID: String, operation: NativeTableStructureAction, index: Int, title: String) {
        self.editing = editing; self.tableID = tableID; self.operation = operation; self.index = index
        super.init(frame: .zero)
        self.title = title; target = self; action = #selector(invoke)
        setAccessibilityLabel(title)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("Use table action") }
    @objc private func invoke() { editing?.performStructure(tableID: tableID, action: operation, index: index) }
}

@MainActor
private final class WeakTableStructureButton {
    weak var value: NativeTableStructureButton?
    init(_ value: NativeTableStructureButton) { self.value = value }
}

@MainActor
public final class NativeTableEditing: NSObject, NSTextViewDelegate {
    private weak var view: NativeEditorView?
    private var buttons: [WeakTableStructureButton] = []
    private var pendingCaret: (cell: NativeTableCellView, text: String, offset: Int)?
    public private(set) var lastFailure: NativeTableEditingFailure?
    init(view: NativeEditorView) { self.view = view }

    /// Explicit trusted-host codec policy; permission remains independently owned
    /// by the shared Session and every mutation revalidates both gates.
    @discardableResult
    public func setPolicy(enabled: Bool, completion: NativeSessionExecutor.Completion? = nil) throws -> NativeSessionOperation {
        guard let view, !view.isDisposed else { throw NativeTableEditingFailure.unavailable }
        return try view.session.submit(.tablePolicy(enabled: enabled), completion: completion)
    }

    public var ownsFirstResponder: Bool {
        guard let cell = view?.window?.firstResponder as? NativeTableCellView else { return false }
        return contains(cell)
    }
    private func supportsCell(_ cell: NativeTableCellView, in table: NativeTableView) -> Bool {
        guard let descriptor = try? NativeTableDescriptor(table.sharedTuple),
              let entry = descriptor.cells.first(where: { $0.coordinate == cell.coordinate }) else { return false }
        return entry.paragraphs.count == 1
    }
    private func contains(_ cell: NativeTableCellView) -> Bool {
        guard let view, !view.isDisposed, let id = cell.tableID else { return false }
        return view.projection.tableViews[id]?.cells[cell.coordinate] === cell
    }
    func refreshCommands() { view?.commands.refreshControls() }
    func removing(_ cell: NativeTableCellView) {
        if view?.window?.firstResponder === cell { _ = view?.window?.makeFirstResponder(view?.textView) }
    }
    public func refresh() {
        guard let view else { return }
        if !view.commands.isPending, let pending = pendingCaret {
            pendingCaret = nil
            if contains(pending.cell), pending.cell.string == pending.text,
               view.window?.firstResponder === pending.cell {
                pending.cell.setSelectedRange(NSRange(location: pending.offset, length: 0))
            }
        }
        let editable = !view.isDisposed && view.projectionFailure == nil && view.sessionSnapshot?.canApply == true
            && !view.commands.isPending && !view.input.isPending && !view.composition.isPending && !view.composition.isActive
            && view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.canPrepare == true
            && view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.available == true
        buttons.removeAll { $0.value == nil }
        for button in buttons.compactMap(\.value) {
            button.isEnabled = editable && view.projection.tableViews[button.tableID] != nil
                && view.commands.catalog?.routes.first(where: { $0.id == "tableStructure" })?.available == true
                && view.commands.catalog?.routes.first(where: { $0.id == "tableStructure" })?.canPrepare == true
        }
        for table in view.projection.tableViews.values {
            for cell in table.cells.values {
                cell.editing = self; cell.tableID = table.nodeID; cell.delegate = self
                cell.isEditable = editable && supportsCell(cell, in: table)
                cell.allowsUndo = false
            }
        }
    }
    @discardableResult
    public func focus(_ cell: NativeTableCellView) -> Bool {
        guard contains(cell), let window = view?.window else { return false }
        return window.makeFirstResponder(cell)
    }
    @discardableResult
    public func move(from cell: NativeTableCellView, forward: Bool) -> Bool {
        guard contains(cell), let view, let id = cell.tableID,
              let table = view.projection.tableViews[id] else { return false }
        let ordered = table.cells.values.sorted {
            ($0.coordinate.row, $0.coordinate.column) < ($1.coordinate.row, $1.coordinate.column)
        }
        guard let index = ordered.firstIndex(where: { $0 === cell }) else { return false }
        let next = forward ? index + 1 : index - 1
        if ordered.indices.contains(next) { return focus(ordered[next]) }
        // Leaving a table never inserts a row or mutates its last cell.
        return view.window?.makeFirstResponder(view.textView) == true
    }
    public func history(redo: Bool) { view?.commands.perform(redo ? .redo : .undo) }
    public func historyAvailable(redo: Bool) -> Bool { view?.commands.availability(redo ? .redo : .undo) == .enabled }

    public func capture(_ cell: NativeTableCellView) throws -> NativeTableCellTarget {
        guard contains(cell), let view, let id = cell.tableID,
              let revision = view.projection.revision,
              let table = view.projection.tableViews[id] else { throw NativeTableEditingFailure.unavailable }
        guard supportsCell(cell, in: table) else { throw NativeTableEditingFailure.unsupportedCell }
        return NativeTableCellTarget(tableID: id, coordinate: cell.coordinate, revision: revision,
            tuple: try JSONSerialization.data(withJSONObject: table.sharedTuple, options: [.sortedKeys]), text: cell.string)
    }
    /// Build only the portable request; Rust alone validates and mutates it.
    public func command(target: NativeTableCellTarget, range: NSRange, replacement: String) throws -> String {
        guard let view, !view.isDisposed, view.projection.revision == target.revision,
              let table = view.projection.tableViews[target.tableID], table.cells[target.coordinate] != nil,
              try JSONSerialization.data(withJSONObject: table.sharedTuple, options: [.sortedKeys]) == target.tuple
        else { throw NativeTableEditingFailure.staleTarget }
        let utf16 = Array(target.text.utf16)
        func boundary(_ index: Int) -> Bool {
            guard index >= 0, index <= utf16.count else { return false }
            return index == 0 || index == utf16.count || !(0xD800...0xDBFF).contains(utf16[index - 1]) || !(0xDC00...0xDFFF).contains(utf16[index])
        }
        guard range.location >= 0, range.length >= 0,
              range.location <= utf16.count, range.length <= utf16.count - range.location,
              boundary(range.location), boundary(range.location + range.length),
              let swiftRange = Range(range, in: target.text), !replacement.contains("\n"), !replacement.contains("\r")
        else { throw NativeTableEditingFailure.invalidRange }
        let text = target.text.replacingCharacters(in: swiftRange, with: replacement)
        guard text.utf8.count <= 1_048_576 else { throw NativeTableEditingFailure.invalidRange }
        let value: [[String: Any]] = [["type": "tableCell", "owner": target.tableID,
            "expected": try JSONSerialization.jsonObject(with: target.tuple),
            "row": target.coordinate.row, "column": target.coordinate.column, "text": text]]
        return String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
    }
    public func replace(target: NativeTableCellTarget, range: NSRange, replacement: String) throws {
        let json = try command(target: target, range: range, replacement: replacement)
        guard let view, view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.available == true,
              view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.canPrepare == true
        else { throw NativeTableEditingFailure.unavailable }
        if let cell = view.projection.tableViews[target.tableID]?.cells[target.coordinate],
           let swiftRange = Range(range, in: target.text) {
            pendingCaret = (cell, target.text.replacingCharacters(in: swiftRange, with: replacement),
                            range.location + replacement.utf16.count)
        }
        view.commands.perform(commandsJSON: json, revision: target.revision)
    }
    public func captureStructure(tableID: String) throws -> NativeTableStructureTarget {
        guard let view, !view.isDisposed, let revision = view.projection.revision,
              let table = view.projection.tableViews[tableID] else { throw NativeTableEditingFailure.unavailable }
        return NativeTableStructureTarget(tableID: tableID, revision: revision,
            tuple: try JSONSerialization.data(withJSONObject: table.sharedTuple, options: [.sortedKeys]))
    }
    public func structureCommand(target: NativeTableStructureTarget, action: NativeTableStructureAction, index: Int) throws -> String {
        guard let view, !view.isDisposed, view.projection.revision == target.revision,
              let table = view.projection.tableViews[target.tableID],
              try JSONSerialization.data(withJSONObject: table.sharedTuple, options: [.sortedKeys]) == target.tuple
        else { throw NativeTableEditingFailure.staleTarget }
        // Geometry, policy, index bounds and admission remain shared planner checks.
        let value: [[String: Any]] = [["type": "tableStructure", "owner": target.tableID,
            "expected": try JSONSerialization.jsonObject(with: target.tuple), "action": action.rawValue, "index": index]]
        return String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
    }
    public func performStructure(tableID: String, action: NativeTableStructureAction, index: Int) {
        do {
            let target = try captureStructure(tableID: tableID)
            let json = try structureCommand(target: target, action: action, index: index)
            view?.commands.perform(commandsJSON: json, revision: target.revision)
            lastFailure = nil
        } catch { lastFailure = error as? NativeTableEditingFailure ?? .unavailable }
    }
    public func makeStructureButton(tableID: String, action: NativeTableStructureAction, index: Int, title: String) -> NativeTableStructureButton {
        let button = NativeTableStructureButton(editing: self, tableID: tableID, operation: action, index: index, title: title)
        buttons.append(WeakTableStructureButton(button)); refresh()
        return button
    }

    public func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange,
                         replacementString: String?) -> Bool {
        guard let cell = textView as? NativeTableCellView, let replacementString else { return false }
        do { try replace(target: capture(cell), range: affectedCharRange, replacement: replacementString); lastFailure = nil }
        catch { lastFailure = error as? NativeTableEditingFailure ?? .unavailable }
        // No provisional native commit or independent UndoManager entry.
        return false
    }
}
