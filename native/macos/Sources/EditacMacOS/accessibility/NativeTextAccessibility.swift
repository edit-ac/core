import AppKit

/// Accessibility reads the current native projection on MainActor. It never
/// acquires the Session worker or waits for a transaction. AppKit continues to
/// supply text, line, screen geometry and keyboard-focus protocols.
@MainActor
public final class NativeTextAccessibility {
    private weak var view: NativeEditorView?
    public var label: String?
    init(view: NativeEditorView) { self.view = view }

    var help: String {
        guard let view, !view.isDisposed, view.sessionSnapshot?.revision != nil,
              view.projectionFailure == nil else { return "Editor unavailable" }
        if view.composition.isActive { return "Composing text" }
        if view.input.isPending || view.composition.isPending || view.commands.isPending {
            return "Applying edit"
        }
        return view.sessionSnapshot?.canApply == true ? "Editable text" : "Read-only text"
    }

    func valid(_ range: NSRange) -> Bool {
        guard let view, !view.isDisposed, let text = view.textView.textStorage?.mutableString else { return false }
        guard range.location != NSNotFound, range.location <= text.length,
              range.length <= text.length - range.location else { return false }
        // UTF-16 ranges may not split a scalar (including either half of emoji).
        func boundary(_ offset: Int) -> Bool {
            offset == 0 || offset == text.length
                || !(0xD800...0xDBFF).contains(text.character(at: offset - 1))
                || !(0xDC00...0xDFFF).contains(text.character(at: offset))
        }
        return boundary(range.location) && boundary(range.location + range.length)
    }

    func select(_ range: NSRange) {
        guard let view, valid(range), !view.applyingProjection else { return }
        view.textView.setSelectedRange(range)
        view.textView.scrollRangeToVisible(range)
        NSAccessibility.post(element: view.textView, notification: .selectedTextChanged)
    }

    func replace(_ text: String, range: NSRange) {
        guard let view, valid(range), !view.applyingProjection,
              view.sessionSnapshot?.canApply == true, !view.composition.isActive,
              !view.input.isPending, !view.commands.isPending, !view.composition.isPending else { return }
        // Uses the same delegate, captured revision, preparation, durable commit
        // and rejection resync as keyboard input. Never calls AppKit's AX setter.
        view.textView.insertText(text, replacementRange: range)
    }

    var actions: [NSAccessibilityCustomAction] {
        guard let view, !view.isDisposed else { return [] }
        let routes: [(NativeCommand, String)] = [(.selectAll, "Select all"), (.copy, "Copy"),
            (.undo, "Undo"), (.redo, "Redo"), (.bold, "Bold"), (.italic, "Italic"),
            (.underline, "Underline"), (.find, "Find")]
        return routes.compactMap { command, name in
            guard view.commands.availability(command) == .enabled else { return nil }
            return NSAccessibilityCustomAction(name: name) { [weak view] in
                MainActor.assumeIsolated {
                    guard let view, !view.isDisposed, !view.applyingProjection,
                          view.commands.availability(command) == .enabled else { return false }
                    view.commands.perform(command)
                    return true
                }
            }
        }
    }
}
