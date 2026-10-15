import AppKit

/// A target belongs to this view/session and is consumed exactly once.
public struct NativeReplacementTarget: Sendable {
    fileprivate let id: UUID
    fileprivate let owner: UUID
    fileprivate let selected: String
}

/// NSTextView keeps TextKit geometry and surrounding-text APIs. Only temporary
/// marked text is written locally; committed content always enters the Session.
@MainActor
final class NativeInputTextView: NSTextView {
    override func accessibilityLabel() -> String? { editor?.accessibility.label ?? super.accessibilityLabel() }
    override func accessibilityHelp() -> String? { editor?.accessibility.help }
    override func accessibilityCustomActions() -> [NSAccessibilityCustomAction]? { editor?.accessibility.actions }
    override func setAccessibilityValue(_ value: Any?) {
        guard let text = value as? String else { return }
        editor?.accessibility.replace(text, range: NSRange(location: 0, length: string.utf16.count))
    }
    override func setAccessibilitySelectedText(_ text: String?) {
        guard let text else { return }
        editor?.accessibility.replace(text, range: selectedRange())
    }
    override func setAccessibilitySelectedTextRange(_ range: NSRange) { editor?.accessibility.select(range) }
    override func setAccessibilitySelectedTextRanges(_ ranges: [NSValue]?) {
        guard let ranges, ranges.count == 1 else { return }
        editor?.accessibility.select(ranges[0].rangeValue)
    }
    override func accessibilityString(for range: NSRange) -> String? {
        guard editor?.accessibility.valid(range) == true else { return nil }
        return super.accessibilityString(for: range)
    }
    override func accessibilityAttributedString(for range: NSRange) -> NSAttributedString? {
        guard editor?.accessibility.valid(range) == true else { return nil }
        return super.accessibilityAttributedString(for: range)
    }
    override func accessibilityFrame(for range: NSRange) -> NSRect {
        guard editor?.accessibility.valid(range) == true else { return .zero }
        return super.accessibilityFrame(for: range)
    }
    override func layout() {
        super.layout()
        editor?.projection.layoutTables()
    }

    weak var editor: NativeEditorView?
    override func hasMarkedText() -> Bool { editor?.composition.isActive == true }
    override func markedRange() -> NSRange {
        editor?.composition.markedRange ?? NSRange(location: NSNotFound, length: 0)
    }
    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        editor?.composition.mark(string, selection: selectedRange, replacement: replacementRange)
    }
    override func insertText(_ string: Any, replacementRange: NSRange) {
        if let owner = editor?.composition, owner.isActive {
            owner.commit(string)
        } else { super.insertText(string, replacementRange: replacementRange) }
    }
    override func unmarkText() { editor?.composition.unmark() }
    override func doCommand(by selector: Selector) {
        if editor?.composition.isActive == true {
            if selector == #selector(NSResponder.cancelOperation(_:)) { editor?.composition.cancel() }
            return
        }
        if selector == #selector(NSResponder.insertNewline(_:)) {
            editor?.commands.perform(.enter); return
        }
        if let command = Self.commandActions[NSStringFromSelector(selector)],
           [.bold, .italic, .underline, .alignLeft].contains(command) {
            editor?.commands.perform(command); return
        }
        if Self.sharedOnlyActions.contains(NSStringFromSelector(selector)) {
            editor?.commands.perform(.structural); return
        }
        super.doCommand(by: selector)
    }
    @objc func undo(_ sender: Any?) { editor?.commands.perform(.undo) }
    @objc func redo(_ sender: Any?) { editor?.commands.perform(.redo) }
    override func performFindPanelAction(_ sender: Any?) { editor?.commands.perform(.find) }
    override func cut(_ sender: Any?) { editor?.commands.perform(.cut) }
    override func paste(_ sender: Any?) { editor?.commands.perform(.paste) }
    override func pasteAsPlainText(_ sender: Any?) { editor?.commands.perform(.pastePlainText) }
    private static let commandActions: [String: NativeCommand] = [
        "undo:": .undo, "redo:": .redo, "selectAll:": .selectAll, "copy:": .copy,
        "cut:": .cut, "paste:": .paste, "pasteAsPlainText:": .pastePlainText,
        "pasteAsRichText:": .paste, "performFindPanelAction:": .find,
        "toggleBoldface:": .bold, "toggleItalics:": .italic, "underline:": .underline,
        "alignLeft:": .alignLeft, "insertNewline:": .enter]
    private static let sharedOnlyActions: Set<String> = ["changeFont:", "changeAttributes:",
        "changeColor:", "alignLeft:", "alignRight:", "alignCenter:", "alignJustified:",
        "subscript:", "superscript:", "unscript:", "underline:"]
    private func command(for action: Selector?) -> NativeCommand? {
        guard let action else { return nil }
        let name = NSStringFromSelector(action)
        return Self.commandActions[name] ?? (Self.sharedOnlyActions.contains(name) ? .structural : nil)
    }
    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if let command = command(for: item.action) {
            return editor?.commands.availability(command) == .enabled
        }
        return super.validateMenuItem(item)
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if let command = command(for: item.action) {
            return editor?.commands.availability(command) == .enabled
        }
        return super.validateUserInterfaceItem(item)
    }
    // AppKit must not modify attributed storage independently while the required
    // shared formatting/structural catalog port is unavailable.
    override func changeFont(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func changeAttributes(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func changeColor(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func alignLeft(_ sender: Any?) { editor?.commands.perform(.alignLeft) }
    override func alignRight(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func alignCenter(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func alignJustified(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func `subscript`(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func superscript(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func unscript(_ sender: Any?) { editor?.commands.perform(.structural) }
    override func underline(_ sender: Any?) { editor?.commands.perform(.underline) }
    @objc func toggleBoldface(_ sender: Any?) { editor?.commands.perform(.bold) }
    @objc func toggleItalics(_ sender: Any?) { editor?.commands.perform(.italic) }
    override func pasteAsRichText(_ sender: Any?) { editor?.commands.perform(.paste) }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        if flags == .command, window?.isKeyWindow == true, window?.firstResponder === self,
           let key = event.charactersIgnoringModifiers?.lowercased(),
           let command: NativeCommand = ["b": .bold, "i": .italic, "u": .underline][key] {
            editor?.commands.perform(command); return true
        }
        guard event.charactersIgnoringModifiers?.lowercased() == "z",
              flags == .command || flags == [.command, .shift],
              window?.isKeyWindow == true, window?.firstResponder === self else { return super.performKeyEquivalent(with: event) }
        editor?.commands.perform(flags.contains(.shift) ? .redo : .undo)
        return true
    }
    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        DispatchQueue.main.async { [weak self] in self?.editor?.commands.refreshControls() }
        return result
    }
    override func resignFirstResponder() -> Bool {
        editor?.composition.unmark()
        let result = super.resignFirstResponder()
        DispatchQueue.main.async { [weak self] in self?.editor?.commands.refreshControls() }
        return result
    }
}

@MainActor
public final class NativeComposition {
    private weak var view: NativeEditorView?
    private let owner = UUID()
    private var targets: Set<UUID> = []
    private var captureWaiters: [UUID: CheckedContinuation<NativeSessionResponse, Error>] = [:]
    var pendingCaptureCount: Int { captureWaiters.count }
    private var target: NativeReplacementTarget?
    private var originalRange: NSRange?
    private var provisional = ""
    private var baseline: NSAttributedString?
    private var originalAffinity: NSSelectionAffinity = .downstream
    public private(set) var recoveryText: String?
    public private(set) var markedRange = NSRange(location: NSNotFound, length: 0)
    public var isActive: Bool { target != nil }
    public private(set) var isPending = false
    public private(set) var acceptedCount = 0
    public private(set) var lastFailure: NativeInputFailure?
    public var onResult: (@MainActor (Result<Void, NativeInputFailure>) -> Void)?
    public var now: @MainActor () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1_000) }

    init(view: NativeEditorView) { self.view = view }
    private func text(_ value: Any) -> String? {
        (value as? NSAttributedString)?.string ?? value as? String
    }
    private func capture(_ range: NSRange) throws -> NativeReplacementTarget {
        guard let view, !view.isDisposed, !isPending, !view.input.isPending, !view.commands.isPending,
              view.sessionSnapshot?.canApply == true, view.projectionFailure == nil, targets.count < 128 else {
            throw NativeInputFailure.unavailable
        }
        let captured = try view.projection.capture(range: range, backwards: false, affinity: .downstream)
        guard captured.anchor.node == captured.focus.node,
              let node = view.projection.nodes.first(where: { $0.id == captured.anchor.node }),
              let selected = Range(NSRange(location: captured.anchor.offsetUTF16,
                  length: captured.focus.offsetUTF16 - captured.anchor.offsetUTF16), in: node.text)
        else { throw NativeInputFailure.unsupportedRange }
        let result = NativeReplacementTarget(id: UUID(), owner: owner, selected: String(node.text[selected]))
        targets.insert(result.id)
        do { try view.session.submit(.captureInput(id: result.id, revision: captured.revision,
            inputs: [AnchorInput(node: captured.anchor.node, offsetUtf16: UInt32(captured.anchor.offsetUTF16), bias: .right),
                     AnchorInput(node: captured.focus.node, offsetUtf16: UInt32(captured.focus.offsetUTF16),
                                 bias: range.length == 0 ? .right : .left)])) { [weak self] response in
                if case let .failure(error) = response {
                    self?.targets.remove(result.id)
                    if self?.target?.id == result.id { self?.cancel() }
                    self?.finish(.failure(.session(error)))
                }
            }
        } catch { targets.remove(result.id); throw error }
        return result
    }

    /// Call before starting an asynchronous OS text-checking/dictation request.
    /// Its completion must return this token, never the then-current caret.
    public func captureReplacement(range: NSRange) async throws -> NativeReplacementTarget {
        guard !isActive else { throw NativeInputFailure.provisionalInput }
        let captured = try capture(range)
        // A FIFO read acknowledges successful anchor capture, without changing it.
        guard let view else { throw NativeInputFailure.unavailable }
        do {
            _ = try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await withCheckedThrowingContinuation { (c: CheckedContinuation<NativeSessionResponse, Error>) in
                    captureWaiters[captured.id] = c
                    do { try view.session.submit(.read(now: now())) { [weak self] result in
                        self?.captureWaiters.removeValue(forKey: captured.id)?.resume(with: result.mapError { $0 as Error })
                    } } catch { captureWaiters.removeValue(forKey: captured.id)?.resume(throwing: error) }
                }
            } onCancel: {
                Task { @MainActor [weak self] in
                    self?.captureWaiters.removeValue(forKey: captured.id)?.resume(throwing: NativeSessionFailure.cancelled)
                }
            }
            guard !Task.isCancelled, targets.contains(captured.id) else { throw NativeInputFailure.unavailable }
        } catch { release(captured); throw error }
        return captured
    }

    public func replace(_ captured: NativeReplacementTarget, with text: String) {
        guard captured.owner == owner, targets.contains(captured.id), !isActive, !isPending else {
            finish(.failure(.unavailable)); return
        }
        submit(captured, text: text)
    }
    public func cancelReplacement(_ captured: NativeReplacementTarget) {
        guard captured.owner == owner else { return }
        release(captured)
    }

    func mark(_ value: Any, selection: NSRange, replacement: NSRange) {
        guard let view, let value = text(value), !isPending else { return }
        do {
            let length = value.utf16.count
            guard selection.location >= 0, selection.location <= length,
                  selection.length >= 0, selection.length <= length - selection.location,
                  NativeTextProjection.isBoundary(selection.location, in: value),
                  NativeTextProjection.isBoundary(selection.location + selection.length, in: value)
            else { throw NativeInputFailure.unsupportedRange }
            if target == nil {
                let range = replacement.location == NSNotFound ? view.textView.selectedRange() : replacement
                target = try capture(range); originalRange = range; markedRange = range
                baseline = view.textView.textStorage.map { NSAttributedString(attributedString: $0) }
                originalAffinity = view.textView.selectionAffinity
                recoveryText = nil
            } else if replacement.location != NSNotFound && replacement != markedRange {
                throw NativeInputFailure.unsupportedRange
            }
            guard let storage = view.textView.textStorage else { throw NativeInputFailure.unavailable }
            view.applyingProjection = true
            storage.replaceCharacters(in: markedRange, with: value)
            markedRange.length = value.utf16.count
            provisional = value; recoveryText = value
            view.textView.setSelectedRange(NSRange(location: markedRange.location + selection.location,
                                                  length: selection.length))
            view.applyingProjection = false
        } catch {
            cancel(); finish(.failure(error as? NativeInputFailure ?? .unsupportedRange))
        }
    }
    func commit(_ value: Any) {
        guard let captured = target, let value = text(value) else { return }
        if value.isEmpty || value == captured.selected { cancel(); return }
        target = nil; markedRange = NSRange(location: NSNotFound, length: 0)
        submit(captured, text: value)
    }
    func unmark() { if isActive { commit(provisional) } }

    public func cancel() {
        guard let captured = target else { return }
        target = nil; markedRange = NSRange(location: NSNotFound, length: 0)
        guard let view, !view.isDisposed else { return }
        targets.remove(captured.id); isPending = true; view.textView.isEditable = false
        do {
            try view.session.submit(.cancelInput(id: captured.id, now: now())) { [weak self, weak view] result in
                guard let self, let view, !view.isDisposed else { return }
                self.isPending = false
                if case let .success(.inputRestored(_, node, start, end)) = result,
                   let projected = view.projection.nodes.first(where: { $0.id == node }) {
                    view.textView.setSelectedRange(NSRange(location: projected.range.location + Int(start),
                        length: Int(end - start)), affinity: self.originalAffinity, stillSelecting: false)
                    self.originalRange = nil
                    view.textView.isEditable = view.sessionSnapshot?.canApply == true && view.projectionFailure == nil
                    self.finish(.success(()))
                } else { self.restore(failure: .unavailable) }
            }
        } catch { restore(failure: .unavailable) }
    }
    /// Reset temporary native storage before the rich mapper reads old ranges.
    func restoreDisplay() {
        guard let baseline, let view else { return }
        view.textView.textStorage?.setAttributedString(baseline)
        self.baseline = nil
    }
    private func release(_ captured: NativeReplacementTarget) {
        targets.remove(captured.id)
        try? view?.session.submit(.releaseInput(id: captured.id))
    }
    private func submit(_ captured: NativeReplacementTarget, text: String) {
        guard let view, !view.isDisposed, !isPending else { return }
        targets.remove(captured.id); isPending = true; view.textView.isEditable = false
        do {
            try view.session.submit(.capturedEdit(id: captured.id, selected: captured.selected, text: text, now: now())) {
                [weak self, weak view] result in
                guard let self, let view, !view.isDisposed else { return }
                switch result {
                case let .success(.inputCommitted(_, node, caret)):
                    self.isPending = false
                    if let projected = view.projection.nodes.first(where: { $0.id == node }) {
                        view.textView.setSelectedRange(NSRange(location: projected.range.location + Int(caret), length: 0))
                    }
                    self.acceptedCount += 1; self.originalRange = nil; self.recoveryText = nil
                    view.textView.isEditable = view.sessionSnapshot?.canApply == true && view.projectionFailure == nil
                    self.finish(.success(()))
                case let .failure(error): self.restore(failure: .session(error))
                default: self.restore(failure: .unavailable)
                }
            }
        } catch { restore(failure: .unavailable) }
    }
    private func restore(failure: NativeInputFailure? = nil) {
        guard let view, !view.isDisposed else { return }
        isPending = true; view.textView.isEditable = false
        do {
            try view.session.submit(.resyncProjection)
            try view.session.submit(.read(now: now())) { [weak self, weak view] _ in
                guard let self, let view, !view.isDisposed else { return }
                self.isPending = false
                // Rejected source/permission results cannot revive stale coordinates.
                view.textView.setSelectedRange(NSRange(location: 0, length: 0))
                self.originalRange = nil
                view.textView.isEditable = view.sessionSnapshot?.canApply == true && view.projectionFailure == nil
                self.finish(failure.map { .failure($0) } ?? .success(()))
            }
        } catch { isPending = false; finish(.failure(.unavailable)) }
    }
    private func finish(_ result: Result<Void, NativeInputFailure>) {
        view?.commands.refreshControls()
        if case let .failure(error) = result { lastFailure = error } else { lastFailure = nil }
        onResult?(result)
    }
    func dispose() {
        restoreDisplay()
        for waiter in captureWaiters.values { waiter.resume(throwing: NativeSessionFailure.disposed) }
        captureWaiters = [:]
        target = nil; targets = []; isPending = false
        markedRange = NSRange(location: NSNotFound, length: 0)
        onResult = nil; view = nil
    }
}
