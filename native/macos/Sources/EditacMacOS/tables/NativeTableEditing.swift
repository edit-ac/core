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

@MainActor
public final class NativeTableEditing: NSObject, NSTextViewDelegate {
    private weak var view: NativeEditorView?
    public private(set) var lastFailure: NativeTableEditingFailure?
    init(view: NativeEditorView) { self.view = view }

    public var ownsFirstResponder: Bool {
        guard let cell = view?.window?.firstResponder as? NativeTableCellView else { return false }
        return contains(cell)
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
        let editable = !view.isDisposed && view.projectionFailure == nil && view.sessionSnapshot?.canApply == true
            && !view.commands.isPending && !view.input.isPending && !view.composition.isPending && !view.composition.isActive
            && view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.canPrepare == true
            && view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.available == true
        for table in view.projection.tableViews.values {
            for cell in table.cells.values {
                cell.editing = self; cell.tableID = table.nodeID; cell.delegate = self
                // Current shared TableCell accepts simple v1 single-line cells.
                cell.isEditable = editable && table.sharedTuple[1] as? Int == 1
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
        guard table.sharedTuple[1] as? Int == 1 else { throw NativeTableEditingFailure.unsupportedCell }
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
        let value: [[String: Any]] = [["type": "tableCell", "target": target.tableID,
            "expected": try JSONSerialization.jsonObject(with: target.tuple),
            "row": target.coordinate.row, "column": target.coordinate.column, "text": text]]
        return String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
    }
    public func replace(target: NativeTableCellTarget, range: NSRange, replacement: String) throws {
        let json = try command(target: target, range: range, replacement: replacement)
        guard let view, view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.available == true,
              view.commands.catalog?.routes.first(where: { $0.id == "tableCell" })?.canPrepare == true
        else { throw NativeTableEditingFailure.unavailable }
        view.commands.perform(commandsJSON: json, revision: target.revision)
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
