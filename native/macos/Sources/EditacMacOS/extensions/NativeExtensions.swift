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
        for child in [title, sourceView, selectButton] { addSubview(child) }
        presentFallback()
    }
    func update(_ value: NativeExtensionDescriptor, factory: NativeExtensions.AtomFactory?) {
        guard !released else { return }
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
                diagnostic = "Native host renderer; editing unavailable"
                if renderer.view.superview !== self { addSubview(renderer.view) }
                sourceView.isHidden = true
            } else { presentFallback() }
        } catch {
            releaseRenderer(); diagnostic = "Renderer failed; source retained"; presentFallback(keepDiagnostic: true)
        }
        guard !released else { return }
        title.stringValue = value.type + " v\(value.version) — " + diagnostic
        setAccessibilityLabel(value.type + ": " + value.source)
        needsLayout = true
    }
    private func presentFallback(keepDiagnostic: Bool = false) {
        if !keepDiagnostic {
            diagnostic = descriptor.type == "editac.math" ? "Math source only; typesetting and source editing unavailable" : "Source fallback — renderer unavailable"
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
    }
    @objc private func selectAtom() {
        Task { [weak self] in guard let self else { return }; try? await owner?.select(nodeID) }
    }
    @available(*, unavailable) public required init?(coder: NSCoder) { fatalError() }
}

/// Registry is per editor and freezes at attachment. Native hooks cannot mutate
/// retained payloads. Full editing awaits the owning shared prepared edit port.
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
    public let mathSourcePresentation = true
    public let mathSourceEditing = false
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
    public func select(_ nodeID: String) async throws {
        guard let view, !disposed, !view.isDisposed else { throw NativeExtensionFailure.disposed }
        guard view.projectionFailure == nil, views[nodeID] != nil,
              let node = view.projection.nodes.first(where: { $0.id == nodeID }) else { throw NativeExtensionFailure.staleTarget }
        try await view.select(range: node.range, backwards: false, affinity: .downstream)
        view.window?.makeFirstResponder(view.textView)
    }
    func dispose() {
        guard !disposed else { return }; disposed = true
        let children = views; views = [:]
        for child in children.values { child.dispose() }
        let hooks = marks; marks = [:]; atoms = [:]
        for hook in hooks.values { hook.dispose() }
    }
}
