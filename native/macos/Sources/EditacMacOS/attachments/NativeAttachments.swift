import AppKit

/// Owned metadata from a qualified portable tuple; never executable content.
public struct NativeAttachmentDescriptor: Equatable, Sendable {
    public enum Kind: String, Sendable { case image, reference }
    public let kind: Kind
    public let target: String
    public let label: String
    public let title: String
    public let source: String

    init?(_ tuple: [Any]) throws {
        guard let tag = tuple.first as? String,
              ["module:editac.image", "module:editac.reference"].contains(tag) else { return nil }
        guard tuple.count == 3, tuple[1] as? Int == 1,
              let data = tuple[2] as? [String: String] else { throw NativeProjectionFailure.malformedRichProjection }
        if tag == "module:editac.image" {
            guard Set(data.keys) == Set(["url", "alt", "title", "source"]),
                  let url = URL(string: data["url"]!), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
                  url.host != nil, url.user == nil, url.password == nil,
                  data["alt"]!.utf8.count <= 8192, data["title"]!.utf8.count <= 2048,
                  data["source"]!.utf8.count <= 1_048_576 else { throw NativeProjectionFailure.malformedRichProjection }
            kind = .image; target = data["url"]!; label = data["alt"]!; title = data["title"]!; source = data["source"]!
        } else {
            guard Set(data.keys) == Set(["targetId", "label"]),
                  [data["targetId"]!, data["label"]!].allSatisfy({ !$0.isEmpty && $0.utf16.count <= 512 &&
                    $0.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) }) else {
                throw NativeProjectionFailure.malformedRichProjection
            }
            kind = .reference; target = data["targetId"]!; label = data["label"]!; title = ""; source = ""
        }
    }
}

public enum NativeAttachmentState: Equatable { case unresolved, loading, ready, failed(String), cancelled }
public enum NativeAttachmentFailure: Error { case unavailablePort, staleTarget, disposed }
public struct NativeAttachmentRequest: Sendable {
    public let id: UUID
    public let nodeID: String
    public let descriptor: NativeAttachmentDescriptor
    public let revision: Data
}

/// Real native image, label and reachable controls; no WebView or URL fetching.
@MainActor
public final class NativeAttachmentView: NSView {
    public let nodeID: String
    public private(set) var descriptor: NativeAttachmentDescriptor
    public private(set) var state: NativeAttachmentState = .unresolved
    public let imageView = NSImageView()
    public let label = NSTextField(wrappingLabelWithString: "")
    public let status = NSTextField(labelWithString: "")
    public let activateButton = NSButton(title: "", target: nil, action: nil)
    public let selectButton = NSButton(title: "Select", target: nil, action: nil)
    public let replaceButton = NSButton(title: "Replace", target: nil, action: nil)
    public let removeButton = NSButton(title: "Remove", target: nil, action: nil)
    public let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
    weak var owner: NativeAttachments?

    init(nodeID: String, descriptor: NativeAttachmentDescriptor) {
        self.nodeID = nodeID; self.descriptor = descriptor
        super.init(frame: .zero)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        for child in [imageView, label, status, activateButton, selectButton, replaceButton, removeButton, cancelButton] { addSubview(child) }
        for button in [activateButton, selectButton, replaceButton, removeButton, cancelButton] { button.target = self }
        activateButton.action = #selector(activate); selectButton.action = #selector(selectAtom)
        replaceButton.action = #selector(replace); removeButton.action = #selector(removeAtom); cancelButton.action = #selector(cancel)
        update(descriptor); setState(.unresolved)
    }
    func update(_ value: NativeAttachmentDescriptor) {
        if descriptor != value { imageView.image = nil; setState(.unresolved) }
        descriptor = value; label.stringValue = value.label
        imageView.setAccessibilityLabel(value.label)
        setAccessibilityLabel(value.kind == .image ? "Image: \(value.label)" : "Reference: \(value.label)")
        toolTip = value.kind == .reference ? value.target : value.title
        activateButton.title = value.kind == .image ? "Load image" : "Open reference"
        // Common native Session does not yet admit image/reference editing.
        replaceButton.isEnabled = false; removeButton.isEnabled = false
        replaceButton.toolTip = "Shared image/reference mutation port unavailable"
        removeButton.toolTip = replaceButton.toolTip
        imageView.isHidden = value.kind != .image
        needsLayout = true
    }
    func setState(_ value: NativeAttachmentState) {
        state = value
        switch value {
        case .unresolved: status.stringValue = "Unresolved — host permission required"
        case .loading: status.stringValue = "Loading"
        case .ready: status.stringValue = "Ready"
        case let .failed(message): status.stringValue = "Unavailable: " + String(message.prefix(256))
        case .cancelled: status.stringValue = "Cancelled"
        }
        status.setAccessibilityLabel(status.stringValue)
        cancelButton.isEnabled = value == .loading
    }
    func fit(width: CGFloat) -> NSSize { NSSize(width: width, height: descriptor.kind == .image ? 190 : 96) }
    public override func layout() {
        super.layout()
        let isImage = descriptor.kind == .image
        imageView.frame = NSRect(x: 8, y: 62, width: 130, height: 120)
        label.frame = NSRect(x: isImage ? 148 : 8, y: 62, width: max(30, bounds.width - (isImage ? 156 : 16)), height: isImage ? 110 : 26)
        status.frame = NSRect(x: 8, y: 36, width: max(30, bounds.width - 16), height: 22)
        var x: CGFloat = 4
        for button in [activateButton, selectButton, replaceButton, removeButton, cancelButton] {
            button.sizeToFit(); button.frame.origin = NSPoint(x: x, y: 4); x += button.frame.width + 2
        }
    }
    @objc private func activate() { owner?.resolve(nodeID) }
    @objc private func selectAtom() { Task { [weak self] in guard let self else { return }; try? await owner?.select(nodeID) } }
    @objc private func cancel() { owner?.cancel(nodeID) }
    @objc private func replace() { try? owner?.replace(nodeID) }
    @objc private func removeAtom() { try? owner?.remove(nodeID) }
    @available(*, unavailable) public required init?(coder: NSCoder) { fatalError() }
}

/// Host ports receive validated inert descriptors. Completion is main-actor-only;
/// host ownership includes allowlists, permissions, decoding and bounded assets.
/// An explicit action is the only loading/activation trigger.
@MainActor
public final class NativeAttachments {
    public typealias ImageResolver = @MainActor (NativeAttachmentRequest, @escaping @MainActor (Result<NSImage, Error>) -> Void) -> Void
    public typealias ReferenceResolver = @MainActor (NativeAttachmentRequest, @escaping @MainActor (Result<String, Error>) -> Void) -> Void
    private weak var view: NativeEditorView?
    public var imageResolver: ImageResolver? { didSet { cancelAll() } }
    public var referenceResolver: ReferenceResolver? { didSet { cancelAll() } }
    public var cancelHostRequest: (@MainActor (UUID) -> Void)?
    public var onReferenceActivated: (@MainActor (NativeAttachmentRequest, String) -> Void)?
    public private(set) var views: [String: NativeAttachmentView] = [:]
    private var pending: [String: NativeAttachmentRequest] = [:]
    private var disposed = false
    init(view: NativeEditorView) { self.view = view }

    func reconcile() throws {
        guard let view, !disposed else { return }
        var descriptors: [String: NativeAttachmentDescriptor] = [:]
        for node in view.projection.richNodes.values {
            if let tuple = node.wire["blockAttributes"] as? [Any], let descriptor = try NativeAttachmentDescriptor(tuple) {
                descriptors[node.id] = descriptor
            }
        }
        for id in Array(pending.keys) {
            if pending[id]?.revision != view.projection.revision || pending[id]?.descriptor != descriptors[id] { cancel(id) }
        }
        for id in Array(views.keys) where descriptors[id] == nil {
            cancel(id); views.removeValue(forKey: id)?.removeFromSuperview()
        }
        guard !disposed, !view.isDisposed else { return }
        for (id, descriptor) in descriptors {
            let child = views[id] ?? NativeAttachmentView(nodeID: id, descriptor: descriptor)
            child.owner = self; child.update(descriptor)
            if child.superview !== view.textView { view.textView.addSubview(child) }
            views[id] = child
        }
        view.projection.layoutTables()
    }
    public func resolve(_ nodeID: String) {
        guard let view, !view.isDisposed, !disposed, view.projectionFailure == nil,
              let revision = view.projection.revision, let child = views[nodeID] else { return }
        cancel(nodeID)
        guard !disposed, !view.isDisposed, pending[nodeID] == nil,
              view.projection.revision == revision,
              currentDescriptor(nodeID) == child.descriptor else { return }
        let request = NativeAttachmentRequest(id: UUID(), nodeID: nodeID, descriptor: child.descriptor, revision: revision)
        pending[nodeID] = request; child.setState(.loading)
        switch child.descriptor.kind {
        case .image:
            guard let resolver = imageResolver else { finishUnavailable(request); return }
            resolver(request) { [weak self] result in
                guard let self, let child = self.accept(request) else { return }
                switch result {
                case let .success(image): child.imageView.image = image; child.setState(.ready)
                case let .failure(error): child.setState(.failed(String(describing: error)))
                }
            }
        case .reference:
            guard let resolver = referenceResolver else { finishUnavailable(request); return }
            resolver(request) { [weak self] result in
                guard let self, let child = self.accept(request) else { return }
                switch result {
                case let .success(value):
                    guard value.utf8.count <= 8192 else { child.setState(.failed("Resolver result too large")); return }
                    child.setState(.ready); self.onReferenceActivated?(request, value)
                case let .failure(error): child.setState(.failed(String(describing: error)))
                }
            }
        }
    }
    private func currentDescriptor(_ nodeID: String) -> NativeAttachmentDescriptor? {
        guard let tuple = view?.projection.richNodes[nodeID]?.wire["blockAttributes"] as? [Any] else { return nil }
        return try? NativeAttachmentDescriptor(tuple)
    }
    private func accept(_ request: NativeAttachmentRequest) -> NativeAttachmentView? {
        guard !disposed, let view, !view.isDisposed, view.projectionFailure == nil,
              pending[request.nodeID]?.id == request.id else { return nil }
        pending.removeValue(forKey: request.nodeID)
        guard view.projection.revision == request.revision,
              let child = views[request.nodeID], child.descriptor == request.descriptor,
              currentDescriptor(request.nodeID) == request.descriptor else { return nil }
        return child
    }
    private func finishUnavailable(_ request: NativeAttachmentRequest) { accept(request)?.setState(.failed("Host resolver unavailable")) }
    public func cancel(_ nodeID: String) {
        guard let request = pending.removeValue(forKey: nodeID) else { return }
        views[nodeID]?.setState(.cancelled)
        cancelHostRequest?(request.id)
    }
    func cancelAll() { for id in Array(pending.keys) { cancel(id) } }
    public func select(_ nodeID: String) async throws {
        guard let view, !disposed, !view.isDisposed else { throw NativeAttachmentFailure.disposed }
        guard views[nodeID] != nil, let node = view.projection.nodes.first(where: { $0.id == nodeID }) else { throw NativeAttachmentFailure.staleTarget }
        try await view.select(range: node.range, backwards: false, affinity: .downstream)
        view.window?.makeFirstResponder(view.textView)
    }
    public func replace(_ nodeID: String) throws { throw NativeAttachmentFailure.unavailablePort }
    public func remove(_ nodeID: String) throws { throw NativeAttachmentFailure.unavailablePort }
    func dispose() {
        disposed = true; cancelAll()
        for child in views.values { child.owner = nil; child.removeFromSuperview() }
        views = [:]; imageResolver = nil; referenceResolver = nil; onReferenceActivated = nil; cancelHostRequest = nil
    }
}
