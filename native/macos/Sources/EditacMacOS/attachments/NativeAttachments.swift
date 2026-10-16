import AppKit

/// Owned metadata from a qualified portable tuple; never executable content.
public struct NativeAttachmentDescriptor: Equatable, Sendable {
    public enum Kind: String, Sendable { case image, reference }
    public let kind: Kind
    public let target: String
    public let label: String
    public let title: String
    public let source: String

    public static func image(url: String, alt: String, title: String = "", source: String = "") throws -> Self {
        try Self(["module:editac.image", 1, ["url": url, "alt": alt, "title": title, "source": source]])!
    }
    public static func reference(targetID: String, label: String) throws -> Self {
        try Self(["module:editac.reference", 1, ["targetId": targetID, "label": label]])!
    }
    fileprivate var tuple: [Any] {
        kind == .image ? ["module:editac.image", 1, ["url": target, "alt": label, "title": title, "source": source]]
            : ["module:editac.reference", 1, ["targetId": target, "label": label]]
    }
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
public enum NativeAttachmentFailure: Error { case unavailablePort, staleTarget, disposed, invalidReplacement }
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
        setAccessibilityElement(true); setAccessibilityRole(.group)
        imageView.setAccessibilityLabel(value.label)
        setAccessibilityLabel(value.kind == .image ? "Image: \(value.label)" : "Reference: \(value.label)")
        toolTip = value.kind == .reference ? value.target : value.title
        activateButton.title = value.kind == .image ? "Load image" : "Open reference"
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
        owner?.accessibilityStateChanged()
    }
    public override func accessibilityPerformPress() -> Bool {
        guard owner != nil, window != nil, selectButton.isEnabled else { return false }
        let focused = window?.makeFirstResponder(selectButton) == true
        owner?.refresh()
        return focused
    }
    public override func accessibilityCustomActions() -> [NSAccessibilityCustomAction]? {
        owner?.refresh()
        return NativeStructureAccessibility.buttonActions(in: self,
            buttons: [activateButton, selectButton, replaceButton, removeButton, cancelButton])
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
    /// A single-use, source-owned anchor and immutable expected descriptor.
    public struct EditTarget {
        public let id: UUID
        public let nodeID: String
        public let descriptor: NativeAttachmentDescriptor
        fileprivate let revision: Data
        fileprivate let anchor: String
    }
    public typealias ReplacementProvider = @MainActor (EditTarget, @escaping @MainActor (Result<NativeAttachmentDescriptor?, Error>) -> Void) -> Void
    public var replacementProvider: ReplacementProvider? { didSet { cancelEdits(); refresh() } }
    private var captures: [String: UUID] = [:]
    private var edits: [UUID: EditTarget] = [:]
    public private(set) var lastEditFailure: Error?

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
        for target in Array(edits.values) where target.revision != view.projection.revision || target.descriptor != descriptors[target.nodeID] { cancel(target.nodeID) }
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
        refresh()
        view.projection.layoutTables()
    }
    func accessibilityStateChanged() { view?.structureAccessibility.refreshAnnouncement() }
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
        captures.removeValue(forKey: nodeID)
        for target in Array(edits.values) where target.nodeID == nodeID {
            edits.removeValue(forKey: target.id); release(target)
            views[nodeID]?.setState(.cancelled)
            cancelHostRequest?(target.id)
        }
        guard let request = pending.removeValue(forKey: nodeID) else { return }
        views[nodeID]?.setState(.cancelled)
        cancelHostRequest?(request.id)
    }
    func cancelAll() { for id in Set(pending.keys).union(captures.keys).union(edits.values.map(\.nodeID)) { cancel(id) } }
    private func cancelEdits() { for id in Set(captures.keys).union(edits.values.map(\.nodeID)) { cancel(id) } }
    public func select(_ nodeID: String) async throws {
        guard let view, !disposed, !view.isDisposed else { throw NativeAttachmentFailure.disposed }
        guard views[nodeID] != nil, let node = view.projection.nodes.first(where: { $0.id == nodeID }) else { throw NativeAttachmentFailure.staleTarget }
        try await view.select(range: node.range, backwards: false, affinity: .downstream)
        view.window?.makeFirstResponder(view.textView)
    }
    @discardableResult
    public func setPolicy(images: Bool, references: Bool, completion: NativeSessionExecutor.Completion? = nil) throws -> NativeSessionOperation {
        guard let view, !disposed, !view.isDisposed else { throw NativeAttachmentFailure.disposed }
        cancelAll()
        return try view.session.submit(.atomicContentPolicy(images: images, references: references), completion: completion)
    }
    private func canEdit(_ child: NativeAttachmentView) -> Bool {
        guard let view, !disposed, !view.isDisposed, view.projectionFailure == nil,
              view.commands.availability(.serviceReplacement) == .enabled else { return false }
        let profile = child.descriptor.kind == .image ? "editac.images" : "editac.references"
        return view.commands.profileAvailability(profile)?.available == true
            && view.commands.catalog?.routes.first(where: { $0.id == "atomicContent" })?.canPrepare == true
    }
    var ownsFirstResponder: Bool {
        guard let view, !disposed, !view.isDisposed,
              let responder = view.window?.firstResponder as? NSView else { return false }
        return views.values.contains { responder.isDescendant(of: $0) }
    }
    func refresh() {
        for child in views.values {
            let enabled = canEdit(child) && captures[child.nodeID] == nil && !edits.values.contains(where: { $0.nodeID == child.nodeID })
            child.removeButton.isEnabled = enabled
            child.replaceButton.isEnabled = enabled && replacementProvider != nil
            child.replaceButton.toolTip = replacementProvider == nil ? "Host replacement service unavailable" : nil
        }
    }
    public func captureEdit(_ nodeID: String) async throws -> EditTarget {
        guard let view, !disposed, !view.isDisposed else { throw NativeAttachmentFailure.disposed }
        guard let child = views[nodeID], canEdit(child), let revision = view.projection.revision else { throw NativeAttachmentFailure.unavailablePort }
        cancel(nodeID)
        let id = UUID(), descriptor = child.descriptor
        captures[nodeID] = id; refresh()
        let response: NativeSessionResponse
        do {
            response = try await withCheckedThrowingContinuation { c in
                do { try view.session.submit(.captureAttachment(revision: revision, node: nodeID)) { c.resume(with: $0.mapError { $0 as Error }) } }
                catch { c.resume(throwing: error) }
            }
        } catch { if captures[nodeID] == id { captures.removeValue(forKey: nodeID) }; refresh(); throw error }
        defer { if captures[nodeID] == id { captures.removeValue(forKey: nodeID) }; refresh() }
        guard case let .anchors(anchors) = response, let anchor = anchors.first else { throw NativeAttachmentFailure.staleTarget }
        let target = EditTarget(id: id, nodeID: nodeID, descriptor: descriptor, revision: revision, anchor: anchor.token)
        guard !disposed, !view.isDisposed, captures[nodeID] == id, view.projection.revision == revision,
              currentDescriptor(nodeID) == descriptor, canEdit(child) else { release(target); throw NativeAttachmentFailure.staleTarget }
        captures.removeValue(forKey: nodeID); edits[id] = target; child.setState(.loading); refresh()
        return target
    }
    private func release(_ target: EditTarget) { try? view?.session.submit(.releaseAttachment(token: target.anchor)) }
    private func commit(_ target: EditTarget, replacement: NativeAttachmentDescriptor?) throws {
        guard let view, !disposed, !view.isDisposed else { throw NativeAttachmentFailure.disposed }
        guard edits[target.id]?.anchor == target.anchor else { throw NativeAttachmentFailure.staleTarget }
        edits.removeValue(forKey: target.id)
        defer {
            release(target)
            if views[target.nodeID]?.state == .loading { views[target.nodeID]?.setState(.cancelled) }
            refresh()
        }
        guard view.projection.revision == target.revision, currentDescriptor(target.nodeID) == target.descriptor,
              let child = views[target.nodeID], canEdit(child) else { throw NativeAttachmentFailure.staleTarget }
        guard replacement == nil || replacement?.kind == target.descriptor.kind else { child.setState(.failed("Invalid replacement")); throw NativeAttachmentFailure.invalidReplacement }
        let values: [[String: Any]] = [["type": "atomicContent", "owner": target.nodeID, "at": target.anchor,
            "expected": target.descriptor.tuple, "replacement": replacement.map { $0.tuple as Any } ?? NSNull()]]
        let json = String(data: try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]), encoding: .utf8)!
        child.setState(.unresolved)
        view.commands.perform(commandsJSON: json, profile: target.descriptor.kind == .image ? "editac.images" : "editac.references", revision: target.revision)
    }
    public func replace(target: EditTarget, with descriptor: NativeAttachmentDescriptor) throws { try commit(target, replacement: descriptor) }
    public func remove(target: EditTarget) throws { try commit(target, replacement: nil) }
    public func replace(_ nodeID: String) throws {
        guard let child = views[nodeID], canEdit(child), let provider = replacementProvider else { throw NativeAttachmentFailure.unavailablePort }
        Task { [weak self] in
            guard let self else { return }
            do {
                let target = try await captureEdit(nodeID)
                provider(target) { [weak self] result in
                    guard let self, self.edits[target.id] != nil else { return }
                    do {
                        switch result {
                        case let .success(descriptor):
                            if let descriptor { try self.replace(target: target, with: descriptor) }
                            else { self.cancel(target.nodeID) }
                        case let .failure(error): self.cancel(target.nodeID); self.views[nodeID]?.setState(.failed(String(describing: error)))
                        }
                    } catch { self.lastEditFailure = error }
                }
            } catch { lastEditFailure = error }
        }
    }
    public func remove(_ nodeID: String) throws {
        guard let child = views[nodeID], canEdit(child) else { throw NativeAttachmentFailure.unavailablePort }
        Task { [weak self] in
            guard let self else { return }
            do { try remove(target: await captureEdit(nodeID)) } catch { lastEditFailure = error }
        }
    }
    func dispose() {
        disposed = true; cancelAll()
        for child in views.values { child.owner = nil; child.removeFromSuperview() }
        views = [:]; replacementProvider = nil; imageResolver = nil; referenceResolver = nil; onReferenceActivated = nil; cancelHostRequest = nil
    }
}
