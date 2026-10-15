import AppKit

public enum NativeInputFailure: Error {
    case unavailable, pending, unsupportedRange, provisionalInput
    case projection(NativeProjectionFailure)
    case session(NativeSessionFailure)
}

/// Captures the proposed native edit before NSTextView changes its projection.
/// Only the Session may publish accepted text. Composition is a separate owner.
@MainActor
public final class NativeCommittedInput: NSObject, NSTextViewDelegate {
    private weak var view: NativeEditorView?
    public private(set) var isPending = false
    public private(set) var acceptedCount = 0
    public private(set) var lastFailure: NativeInputFailure?
    public var now: @MainActor () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1_000) }
    public var onResult: (@MainActor (Result<Void, NativeInputFailure>) -> Void)?

    init(view: NativeEditorView) { self.view = view }

    public func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange,
                         replacementString: String?) -> Bool {
        route(range: affectedCharRange, replacement: replacementString)
        return false
    }

    public func textView(_ textView: NSTextView, shouldChangeTextInRanges affectedRanges: [NSValue],
                         replacementStrings: [String]?) -> Bool {
        guard affectedRanges.count == 1, replacementStrings?.count == 1 else {
            finish(.failure(.unsupportedRange)); return false
        }
        route(range: affectedRanges[0].rangeValue, replacement: replacementStrings?[0])
        return false
    }

    public func textViewDidChangeSelection(_ notification: Notification) {
        guard let view, !view.isDisposed, !view.applyingProjection else { return }
        view.projection.refreshTypingStyle()
        view.commands.refreshControls()
    }

    private func route(range: NSRange, replacement: String?) {
        guard let view, !view.isDisposed, !view.applyingProjection,
              view.projectionFailure == nil else { return }
        guard !view.commands.isPending, !view.composition.isPending else { finish(.failure(.pending)); return }
        guard !isPending else { finish(.failure(.pending)); return }
        guard !view.textView.hasMarkedText() else { finish(.failure(.provisionalInput)); return }
        guard let replacement else { finish(.failure(.unsupportedRange)); return }
        do {
            let target = try view.projection.capture(range: range, backwards: false,
                                                    affinity: view.textView.selectionAffinity)
            // Structural joins/splits are not inferred from display separators.
            // Shared structural commands are wired by their later owner.
            guard target.anchor.node == target.focus.node else {
                finish(.failure(.unsupportedRange)); return
            }
            let edit = NativeSessionEdit(node: target.anchor.node,
                fromUtf16: UInt32(target.anchor.offsetUTF16),
                toUtf16: UInt32(target.focus.offsetUTF16), text: replacement)
            isPending = true
            view.textView.isEditable = false
            try view.session.submit(.nativeEdit(revision: target.revision, edits: [edit], now: now())) {
                [weak self, weak view] result in
                guard let self, let view, !view.isDisposed else { return }
                self.isPending = false
                view.textView.isEditable = view.projectionFailure == nil && view.sessionSnapshot?.canApply == true
                switch result {
                case .success:
                    guard view.projectionFailure == nil else {
                        self.finish(.failure(.unavailable)); return
                    }
                    // This caret is derived from the just-accepted shared edit,
                    // never applied to a different snapshot or guessed after failure.
                    if let node = view.projection.nodes.first(where: { $0.id == target.anchor.node }) {
                        let caret = NSRange(location: node.range.location + target.anchor.offsetUTF16
                                            + replacement.utf16.count, length: 0)
                        if let selection = try? view.projection.capture(range: caret, backwards: false,
                                                                        affinity: .downstream) {
                            try? view.projection.select(selection)
                        }
                    }
                    self.acceptedCount += 1
                    self.finish(.success(()))
                case let .failure(error):
                    // Native storage was never changed, so rejection preserves
                    // the currently authoritative text and selection exactly.
                    self.isPending = true
                    view.textView.isEditable = false
                    do {
                        try view.session.submit(.read(now: self.now())) { [weak self, weak view] _ in
                            guard let self, let view, !view.isDisposed else { return }
                            self.isPending = false
                            view.textView.isEditable = view.projectionFailure == nil
                                && view.sessionSnapshot?.canApply == true
                            self.finish(.failure(.session(error)))
                        }
                    } catch {
                        self.isPending = false
                        view.textView.isEditable = false
                        self.finish(.failure(.unavailable))
                    }
                }
            }
        } catch let error as NativeProjectionFailure {
            isPending = false; view.textView.isEditable = view.projectionFailure == nil && view.sessionSnapshot?.canApply == true
            finish(.failure(.projection(error)))
        } catch {
            isPending = false; view.textView.isEditable = view.projectionFailure == nil && view.sessionSnapshot?.canApply == true
            finish(.failure(.session(error as? NativeSessionFailure ?? .unexpected(String(describing: error)))))
        }
    }

    private func finish(_ result: Result<Void, NativeInputFailure>) {
        view?.commands.refreshControls()
        if case let .failure(error) = result { lastFailure = error } else { lastFailure = nil }
        onResult?(result)
    }

    func dispose() { view = nil; onResult = nil; isPending = false }
}
