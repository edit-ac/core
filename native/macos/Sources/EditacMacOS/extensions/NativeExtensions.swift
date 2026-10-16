import AppKit
import CoreFoundation

public enum NativeExtensionFailure: Error, Equatable {
    case frozen, duplicate, invalidDescriptor, unavailableEditing, disposed, staleTarget
}

/// An owned, inert projection. Exact tuple bytes remain available even when a
/// renderer is absent; the descriptor never registers schema or grants editing.
public struct NativeExtensionDescriptor: Equatable, Sendable {
    public let type: String
    public let version: UInt32
    public let source: String
    public let tupleJSON: Data
    public let payloadJSON: Data

    init?(_ tuple: [Any]) throws {
        guard let tag = tuple.first as? String, tag.hasPrefix("module:"),
              !["module:editac.image", "module:editac.reference", "module:editac.table"].contains(tag) else { return nil }
        guard tuple.count == 3, let number = tuple[1] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue >= 1,
              number.doubleValue <= Double(UInt32.max), number.doubleValue.rounded() == number.doubleValue,
              let data = tuple[2] as? [String: Any], JSONSerialization.isValidJSONObject(tuple) else {
            throw NativeExtensionFailure.invalidDescriptor
        }
        tupleJSON = try JSONSerialization.data(withJSONObject: tuple, options: [.sortedKeys])
        guard tupleJSON.count <= 1_048_576 else { throw NativeExtensionFailure.invalidDescriptor }
        if tag == "module:editac.inert-extension", number.intValue == 1 {
            guard let type = data["type"] as? String, !type.isEmpty, type.utf8.count <= 128,
                  let version = data["dataVersion"] as? NSNumber,
                  CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue >= 1,
                  version.doubleValue <= Double(UInt32.max), version.doubleValue.rounded() == version.doubleValue,
                  data["version"] as? Int == 1, let source = data["source"] as? String,
                  let payload = data["payload"] else { throw NativeExtensionFailure.invalidDescriptor }
            self.type = type; self.version = version.uint32Value; self.source = source
            payloadJSON = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .fragmentsAllowed])
        } else {
            type = String(tag.dropFirst(7)); version = number.uint32Value
            source = data["source"] as? String ?? "Unsupported content (source unavailable)"
            payloadJSON = try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
        }
    }
}

/// Trusted host objects only. Updates run on the UI executor, after the Session
/// transaction. Implementations own their subscriptions and release them in dispose.
@MainActor public protocol NativeAtomRenderer: AnyObject {
    var view: NSView { get }
    func update(_ descriptor: NativeExtensionDescriptor) throws
    func dispose()
}

@MainActor
public final class NativeExtensionView: NSView {
    public let nodeID: String
    public private(set) var descriptor: NativeExtensionDescriptor
    public private(set) var diagnostic: String
    public private(set) var renderer: (any NativeAtomRenderer)?
    public let sourceView = NSTextView()
    public let editButton = NSButton(title: "Edit source", target: nil, action: nil)
    public let saveButton = NSButton(title: "Save", target: nil, action: nil)
    public let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
    public let selectButton = NSButton(title: "Select atom", target: nil, action: nil)
    private let title = NSTextField(labelWithString: "")
    private weak var owner: NativeExtensions?
    private var released = false

    init(nodeID: String, descriptor: NativeExtensionDescriptor, owner: NativeExtensions) {
        self.nodeID = nodeID; self.descriptor = descriptor; self.owner = owner
        diagnostic = "Source fallback — renderer unavailable"
        super.init(frame: .zero)
        sourceView.isEditable = false; sourceView.isSelectable = true
        sourceView.isRichText = false; sourceView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        selectButton.target = self; selectButton.action = #selector(selectAtom)
        editButton.target = self; editButton.action = #selector(editSource)
        saveButton.target = self; saveButton.action = #selector(saveSource)
        cancelButton.target = self; cancelButton.action = #selector(cancelSource)
        for child in [title, sourceView, selectButton, editButton, saveButton, cancelButton] { addSubview(child) }
        presentFallback()
    }
    func update(_ value: NativeExtensionDescriptor, factory: NativeExtensions.AtomFactory?) {
        guard !released else { return }
        let draft = owner?.isEditing(nodeID) == true ? sourceView.string : nil
        let changed = value != descriptor
        if descriptor.type != value.type || descriptor.version != value.version { releaseRenderer() }
        descriptor = value
        if renderer == nil, diagnostic == "Renderer failed; source retained", !changed { return }
        do {
            if renderer == nil, let factory {
                let created = try factory(value)
                guard !released else { created.dispose(); return }
                renderer = created
            }
            if let renderer {
                try renderer.update(value)
                guard !released else { return }
                diagnostic = "Native host renderer"
                if renderer.view.superview !== self { addSubview(renderer.view) }
                sourceView.isHidden = true
            } else { presentFallback() }
        } catch {
            releaseRenderer(); diagnostic = "Renderer failed; source retained"; presentFallback(keepDiagnostic: true)
        }
        guard !released else { return }
        title.stringValue = value.type + " v\(value.version) — " + diagnostic
        setAccessibilityLabel(value.type + ": " + value.source)
        if let draft { sourceView.string = draft }
        refreshEditing()
        needsLayout = true
    }
    func refreshEditing() {
        let editing = owner?.isEditing(nodeID) == true
        sourceView.isEditable = editing
        if editing { sourceView.isHidden = false; renderer?.view.isHidden = true }
        else { renderer?.view.isHidden = false }
        editButton.isEnabled = owner?.canEdit(nodeID) == true && !editing
        saveButton.isEnabled = editing && owner?.canEdit(nodeID) == true
        cancelButton.isEnabled = editing
    }
    @objc private func editSource() {
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await owner?.captureEdit(nodeID); refreshEditing(); window?.makeFirstResponder(sourceView) }
            catch { editButton.toolTip = String(describing: error) }
        }
    }
    @objc private func saveSource() { do { try owner?.save(nodeID, source: sourceView.string) } catch { saveButton.toolTip = String(describing: error) } }
    @objc private func cancelSource() { owner?.cancel(nodeID) }
    private func presentFallback(keepDiagnostic: Bool = false) {
        if !keepDiagnostic {
            diagnostic = descriptor.type == "editac.math" ? "Math source only; typesetting unavailable" : "Source fallback — renderer unavailable"
        }
        sourceView.string = descriptor.source; sourceView.isHidden = false
        sourceView.setAccessibilityLabel(descriptor.type == "editac.math" ? "Math source" : "Preserved extension source")
        title.stringValue = descriptor.type + " v\(descriptor.version) — " + diagnostic
    }
    private func releaseRenderer() {
        let old = renderer; renderer = nil
        old?.view.removeFromSuperview(); old?.dispose()
    }
    func dispose() {
        guard !released else { return }; released = true; owner = nil
        releaseRenderer(); removeFromSuperview()
    }
    func fit(width: CGFloat) -> NSSize { NSSize(width: width, height: 140) }
    public override func layout() {
        super.layout()
        title.frame = NSRect(x: 8, y: 112, width: max(1, bounds.width - 16), height: 24)
        let body = NSRect(x: 8, y: 32, width: max(1, bounds.width - 16), height: 78)
        sourceView.frame = body; renderer?.view.frame = body
        selectButton.frame = NSRect(x: 4, y: 2, width: 110, height: 28)
        editButton.frame = NSRect(x: 116, y: 2, width: 110, height: 28)
        saveButton.frame = NSRect(x: 228, y: 2, width: 66, height: 28)
        cancelButton.frame = NSRect(x: 296, y: 2, width: 76, height: 28)
    }
    @objc private func selectAtom() {
        Task { [weak self] in guard let self else { return }; try? await owner?.select(nodeID) }
    }
    @available(*, unavailable) public required init?(coder: NSCoder) { fatalError() }
}

/// Host-installed native formatting action; no document callback or semantic model.
@MainActor public final class NativeExtensionMarkButton: NSButton {
    fileprivate weak var owner: NativeExtensions?
    fileprivate let attribute: String
    fileprivate let valueJSON: Data?
    fileprivate init(owner: NativeExtensions, attribute: String, valueJSON: Data?, title: String) {
        self.owner = owner; self.attribute = attribute; self.valueJSON = valueJSON
        super.init(frame: .zero); self.title = title; target = self; action = #selector(invoke)
        setAccessibilityLabel(title)
    }
    @objc private func invoke() {
        do { try owner?.applySelectedMark(attribute: attribute, valueJSON: valueJSON) }
        catch { toolTip = String(describing: error) }
    }
    @available(*, unavailable) public required init?(coder: NSCoder) { fatalError() }
}

/// Registry is per editor and freezes at attachment. Native hooks cannot mutate
/// retained payloads. Edits use the shared prepared Session port.
@MainActor
public final class NativeExtensions {
    public typealias AtomFactory = @MainActor (NativeExtensionDescriptor) throws -> any NativeAtomRenderer
    public typealias MarkPresenter = @MainActor (Data) throws -> [NSAttributedString.Key: Any]
    private struct Key: Hashable { let type: String; let version: UInt32 }
    private struct MarkHook { let present: MarkPresenter; let dispose: @MainActor () -> Void }
    private weak var view: NativeEditorView?
    private var atoms: [Key: AtomFactory] = [:]
    private var marks: [String: MarkHook] = [:]
    public private(set) var views: [String: NativeExtensionView] = [:]
    public private(set) var isFrozen = false
    private var disposed = false
    public struct EditTarget: Equatable, Sendable {
        fileprivate let id: UUID
        public let nodeID: String
        public let descriptor: NativeExtensionDescriptor
        public let revision: Data
        fileprivate let anchor: String
    }
    private var edits: [String: EditTarget] = [:]
    private var captures: [String: UUID] = [:]
    private struct WeakButton { weak var value: NativeExtensionMarkButton? }
    private var buttons: [WeakButton] = []
    public let mathSourcePresentation = true
    public let mathSourceEditing = true
    public let mathTypesetting = false
    init(view: NativeEditorView) { self.view = view }

    private func admit() throws {
        guard !disposed else { throw NativeExtensionFailure.disposed }
        guard !isFrozen else { throw NativeExtensionFailure.frozen }
    }
    public func registerAtom(type: String, version: UInt32, factory: @escaping AtomFactory) throws {
        try admit()
        guard !type.isEmpty, type.utf8.count <= 128, version > 0 else { throw NativeExtensionFailure.invalidDescriptor }
        let key = Key(type: type, version: version)
        guard atoms[key] == nil else { throw NativeExtensionFailure.duplicate }
        atoms[key] = factory
    }
    public func registerMark(attribute: String, present: @escaping MarkPresenter,
                             dispose: @escaping @MainActor () -> Void = {}) throws {
        try admit()
        guard !attribute.isEmpty, attribute.utf8.count <= 128 else { throw NativeExtensionFailure.invalidDescriptor }
        guard marks[attribute] == nil else { throw NativeExtensionFailure.duplicate }
        marks[attribute] = MarkHook(present: present, dispose: dispose)
    }
    // Only display keys may be supplied. Shared wire, attachment geometry, links
    // and paragraph coordinates remain owned by their qualified adapters.
    private static let allowed: Set<NSAttributedString.Key> = [.font, .foregroundColor, .backgroundColor, .underlineStyle, .strikethroughStyle]
    func presentMarks(in storage: NSTextStorage) {
        guard !disposed else { return }
        var updates: [(NSRange, [NSAttributedString.Key: Any])] = []
        storage.enumerateAttribute(NativeTextProjection.sharedRunAttributes, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let attributes = value as? [String: Any] else { return }
            for key in marks.keys.sorted() {
                guard let payload = attributes[key], let hook = marks[key],
                      let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .fragmentsAllowed]),
                      let result = try? hook.present(data), !disposed else { continue }
                updates.append((range, result.filter { Self.allowed.contains($0.key) }))
            }
        }
        guard !disposed else { return }
        for (range, attributes) in updates { storage.addAttributes(attributes, range: range) }
    }
    func reconcile() throws {
        guard let view, !disposed, !view.isDisposed else { return }
        isFrozen = true
        for id in Array(edits.keys) where edits[id]?.revision != view.projection.revision { cancel(id) }
        var descriptors: [String: NativeExtensionDescriptor] = [:]
        for node in view.projection.richNodes.values {
            if let tuple = node.wire["blockAttributes"] as? [Any], let value = try NativeExtensionDescriptor(tuple) { descriptors[node.id] = value }
        }
        for id in Array(views.keys) where descriptors[id] == nil { views.removeValue(forKey: id)?.dispose() }
        for id in descriptors.keys.sorted() {
            guard !disposed, !view.isDisposed else { return }
            let descriptor = descriptors[id]!
            let child = views[id] ?? NativeExtensionView(nodeID: id, descriptor: descriptor, owner: self)
            views[id] = child
            child.update(descriptor, factory: atoms[Key(type: descriptor.type, version: descriptor.version)])
            guard !disposed, !view.isDisposed else { return }
            if child.superview !== view.textView { view.textView.addSubview(child) }
        }
        if let storage = view.textView.textStorage { presentMarks(in: storage) }
        view.projection.layoutTables()
    }
    func refresh() {
        for child in views.values { child.refreshEditing() }
        buttons.removeAll { $0.value == nil }
        for box in buttons {
            guard let button = box.value else { continue }
            button.isEnabled = !disposed && marks[button.attribute] != nil &&
                view?.commands.catalog?.routes.first(where: { $0.id == "customMarkAt" })?.available == true &&
                view?.commands.availability(.serviceReplacement) == .enabled
        }
    }
    public func makeMarkButton(attribute: String, valueJSON: Data?, title: String) -> NativeExtensionMarkButton {
        let button = NativeExtensionMarkButton(owner: self, attribute: attribute, valueJSON: valueJSON, title: title)
        buttons.append(WeakButton(value: button)); refresh(); return button
    }
    public func applySelectedMark(attribute: String, valueJSON: Data?) throws {
        guard let view else { throw NativeExtensionFailure.disposed }
        let target = try view.projection.capture(range: view.textView.selectedRange(), backwards: false, affinity: view.textView.selectionAffinity)
        try applyMark(attribute: attribute, valueJSON: valueJSON, target: target)
    }
    func isEditing(_ nodeID: String) -> Bool { edits[nodeID] != nil }
    func canEdit(_ nodeID: String) -> Bool {
        guard let view, !disposed, !view.isDisposed, let child = views[nodeID],
              child.descriptor.tupleJSON.count > 0, view.projectionFailure == nil,
              view.commands.availability(.serviceReplacement) == .enabled,
              view.commands.catalog?.routes.first(where: { $0.id == "extensionSource" })?.available == true else { return false }
        // Only the qualified inert envelope has a source edit contract. Unknown
        // type/version and payload remain inert and are preserved by that port.
        return (try? JSONSerialization.jsonObject(with: child.descriptor.tupleJSON) as? [Any])?.first as? String == "module:editac.inert-extension"
    }
    @discardableResult public func setPolicy(enabled: Bool, completion: NativeSessionExecutor.Completion? = nil) throws -> NativeSessionOperation {
        guard let view, !disposed else { throw NativeExtensionFailure.disposed }
        if !enabled { for id in Set(edits.keys).union(captures.keys) { cancel(id) } }
        return try view.session.submit(.extensionPolicy(enabled: enabled), completion: completion)
    }
    public func captureEdit(_ nodeID: String) async throws -> EditTarget {
        guard let view, !disposed, !view.isDisposed else { throw NativeExtensionFailure.disposed }
        guard canEdit(nodeID), let descriptor = views[nodeID]?.descriptor, let revision = view.projection.revision else { throw NativeExtensionFailure.unavailableEditing }
        cancel(nodeID)
        let id = UUID(); captures[nodeID] = id
        let response: NativeSessionResponse
        do {
            response = try await withCheckedThrowingContinuation { c in
                do { try view.session.submit(.captureAttachment(revision: revision, node: nodeID)) { c.resume(with: $0.mapError { $0 as Error }) } }
                catch { c.resume(throwing: error) }
            }
        } catch { if captures[nodeID] == id { captures.removeValue(forKey: nodeID) }; throw error }
        guard case let .anchors(anchors) = response, let anchor = anchors.first else { throw NativeExtensionFailure.staleTarget }
        let target = EditTarget(id: id, nodeID: nodeID, descriptor: descriptor, revision: revision, anchor: anchor.token)
        guard captures[nodeID] == id, !disposed, !view.isDisposed, view.projection.revision == revision,
              views[nodeID]?.descriptor == descriptor, canEdit(nodeID) else {
            try? view.session.submit(.releaseAttachment(token: anchor.token)); throw NativeExtensionFailure.staleTarget
        }
        captures.removeValue(forKey: nodeID); edits[nodeID] = target
        views[nodeID]?.refreshEditing()
        return target
    }
    public func cancel(_ nodeID: String) {
        captures.removeValue(forKey: nodeID)
        if let target = edits.removeValue(forKey: nodeID) { try? view?.session.submit(.releaseAttachment(token: target.anchor)) }
        if let child = views[nodeID] { child.sourceView.string = child.descriptor.source; child.refreshEditing() }
    }
    public func save(_ nodeID: String, source: String) throws {
        guard let target = edits[nodeID] else { throw NativeExtensionFailure.staleTarget }
        try replace(target: target, source: source)
    }
    public func replace(target: EditTarget, source: String) throws {
        guard let view, !disposed, !view.isDisposed else { throw NativeExtensionFailure.disposed }
        guard edits[target.nodeID] == target else { throw NativeExtensionFailure.staleTarget }
        defer { cancel(target.nodeID) }
        guard source.utf16.count <= 8192 else { throw NativeExtensionFailure.invalidDescriptor }
        guard target.revision == view.projection.revision, views[target.nodeID]?.descriptor == target.descriptor,
              canEdit(target.nodeID) else { throw NativeExtensionFailure.staleTarget }
        let tuple = try JSONSerialization.jsonObject(with: target.descriptor.tupleJSON)
        let json = try JSONSerialization.data(withJSONObject: [["type": "extensionSource", "owner": target.nodeID,
            "expected": tuple, "at": target.anchor, "source": source]], options: [.sortedKeys])
        view.commands.perform(commandsJSON: String(decoding: json, as: UTF8.self), revision: target.revision)
    }
    public func applyMark(attribute: String, valueJSON: Data?, target: NativeTextSelectionTarget) throws {
        guard let view, !disposed, !view.isDisposed else { throw NativeExtensionFailure.disposed }
        guard marks[attribute] != nil, target.owner == view.projection.owner,
              target.revision == view.projection.revision, target.anchor.node == target.focus.node else { throw NativeExtensionFailure.staleTarget }
        let value: Any = try valueJSON.map { try JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) } ?? NSNull()
        let json = try JSONSerialization.data(withJSONObject: [["type": "customMarkAt", "owner": target.anchor.node,
            "from": min(target.anchor.offsetUTF16, target.focus.offsetUTF16), "to": max(target.anchor.offsetUTF16, target.focus.offsetUTF16),
            "key": attribute, "value": value]], options: [.sortedKeys])
        view.commands.perform(commandsJSON: String(decoding: json, as: UTF8.self), revision: target.revision)
    }
    public func select(_ nodeID: String) async throws {
        guard let view, !disposed, !view.isDisposed else { throw NativeExtensionFailure.disposed }
        guard view.projectionFailure == nil, views[nodeID] != nil,
              let node = view.projection.nodes.first(where: { $0.id == nodeID }) else { throw NativeExtensionFailure.staleTarget }
        try await view.select(range: node.range, backwards: false, affinity: .downstream)
        view.window?.makeFirstResponder(view.textView)
    }
    func dispose() {
        guard !disposed else { return }
        for id in Set(edits.keys).union(captures.keys) { cancel(id) }
        disposed = true
        for button in buttons { button.value?.isEnabled = false; button.value?.owner = nil }; buttons = []
        let children = views; views = [:]
        for child in children.values { child.dispose() }
        let hooks = marks; marks = [:]; atoms = [:]
        for hook in hooks.values { hook.dispose() }
    }
}
