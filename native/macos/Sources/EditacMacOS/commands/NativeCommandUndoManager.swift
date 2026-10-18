import AppKit

/// A platform entry point, not a second undo stack. AppKit uses canUndo/canRedo
/// to enable native affordances even when NSTextView.allowsUndo is false.
final class NativeCommandUndoManager: UndoManager, @unchecked Sendable {
    private weak var view: NativeEditorView?

    @MainActor init(view: NativeEditorView) {
        self.view = view
        super.init()
        disableUndoRegistration()
    }

    override var canUndo: Bool {
        MainActor.assumeIsolated { view?.commands.availability(.undo) == .enabled }
    }

    override var canRedo: Bool {
        MainActor.assumeIsolated { view?.commands.availability(.redo) == .enabled }
    }

    override func undo() {
        MainActor.assumeIsolated { view?.commands.perform(.undo) }
    }

    override func redo() {
        MainActor.assumeIsolated { view?.commands.perform(.redo) }
    }

    override func undoNestedGroup() { undo() }
}
