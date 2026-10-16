import AppKit

/// Untrusted data and the original view's revision-scoped coordinates. A shared
/// prepared transfer is still required before any mutation. External drops are
/// copy offers; an OS drag effect never authorizes source deletion.
public struct NativeClipboardDelivery: Sendable {
    public let offer: NativeClipboardOffer
    public let target: NativeTextSelectionTarget
}

@MainActor
public final class NativeClipboardRead {
    public private(set) var isFinished = false
    private var progress: Progress?
    private var loading = false
    private var completion: (@MainActor (Result<NativeClipboardDelivery, NativeClipboardFailure>) -> Void)?
    private let validate: @MainActor () -> NativeClipboardFailure?
    private let target: NativeTextSelectionTarget

    fileprivate init(target: NativeTextSelectionTarget,
                     validate: @escaping @MainActor () -> NativeClipboardFailure?,
                     completion: @escaping @MainActor (Result<NativeClipboardDelivery, NativeClipboardFailure>) -> Void) {
        self.target = target; self.validate = validate; self.completion = completion
    }

    public func cancel() {
        guard !isFinished else { return }
        progress?.cancel()
        finish(.failure(.cancelled))
    }

    /// Host data providers may deliver late or more than once. Consume at most
    /// once, and recheck the original view rather than looking up current focus.
    public func receive(_ result: Result<NativeClipboardOffer, NativeClipboardFailure>) {
        guard !isFinished else { return }
        if let failure = validate() { finish(.failure(failure)); return }
        finish(result.map { NativeClipboardDelivery(offer: $0, target: target) })
    }

    private func finish(_ result: Result<NativeClipboardDelivery, NativeClipboardFailure>) {
        guard !isFinished else { return }
        isFinished = true
        let callback = completion
        completion = nil
        progress?.cancel(); progress = nil
        callback?(result)
    }

    /// NSItemProvider is an actual OS asynchronous transport. Its bytes remain
    /// untrusted; no decoder, network, asset resolver, or mutation runs here.
    public func load(from provider: NSItemProvider, literal: Bool = false) throws {
        guard !isFinished, !loading else { throw NativeClipboardFailure.alreadyConsumed }
        if let failure = validate() { finish(.failure(failure)); return }
        let candidates = literal ? [NativeClipboardFlavor.plain] : NativeClipboardFlavor.allCases
        let offered = candidates.filter { provider.registeredTypeIdentifiers.contains($0.rawValue) }
        guard !offered.isEmpty else {
            finish(.failure(.unsupportedTypes)); return
        }
        loading = true
        load(provider, remaining: offered, values: [:])
    }

    private func load(_ provider: NSItemProvider, remaining: [NativeClipboardFlavor],
                      values: [NativeClipboardFlavor: Data]) {
        guard !isFinished else { return }
        if let failure = validate() { finish(.failure(failure)); return }
        guard let flavor = remaining.first else {
            do { receive(.success(try NativeClipboardOffer(values))) }
            catch let failure as NativeClipboardFailure { receive(.failure(failure)) }
            catch { receive(.failure(.providerFailed)) }
            return
        }
        progress = provider.loadDataRepresentation(forTypeIdentifier: flavor.rawValue) { [weak self] bytes, error in
            Task { @MainActor [weak self] in
                guard let self, !self.isFinished else { return }
                guard error == nil, let bytes else { self.receive(.failure(.providerFailed)); return }
                var combined = values; combined[flavor] = bytes
                do { _ = try NativeClipboardOffer(combined) }
                catch let failure as NativeClipboardFailure { self.receive(.failure(failure)); return }
                catch { self.receive(.failure(.providerFailed)); return }
                self.load(provider, remaining: Array(remaining.dropFirst()), values: combined)
            }
        }
    }
}

/// Native transport prerequisite. Edit menu/drag mutation is connected only
/// after the qualified shared fragment/anchor/receipt API is available.
@MainActor
public final class NativeClipboardInput {
    private weak var view: NativeEditorView?
    private var reads: [UUID: NativeClipboardRead] = [:]
    init(view: NativeEditorView) { self.view = view }
    public var pendingCount: Int { reads.count }

    public func begin(completion: @escaping @MainActor (Result<NativeClipboardDelivery, NativeClipboardFailure>) -> Void) throws -> NativeClipboardRead {
        guard let view, !view.isDisposed, view.projectionFailure == nil,
              let revision = view.sessionSnapshot?.revision else { throw NativeClipboardFailure.unavailableTarget }
        guard view.sessionSnapshot?.canApply == true else { throw NativeClipboardFailure.readOnly }
        guard !view.composition.isActive, !view.input.isPending, !view.composition.isPending,
              !view.commands.isPending else { throw NativeClipboardFailure.unavailableTarget }
        let target = try view.projection.capture(range: view.textView.selectedRange(), backwards: false,
                                                 affinity: view.textView.selectionAffinity)
        let id = UUID()
        let read = NativeClipboardRead(target: target, validate: { [weak view] in
            guard let view, !view.isDisposed, view.projectionFailure == nil,
                  view.sessionSnapshot?.revision != nil else { return .unavailableTarget }
            guard view.sessionSnapshot?.canApply == true else { return .readOnly }
            guard view.sessionSnapshot?.revision == revision else { return .staleTarget }
            guard !view.composition.isActive, !view.input.isPending, !view.composition.isPending,
                  !view.commands.isPending else { return .unavailableTarget }
            return nil
        }, completion: { [weak self] result in
            self?.reads.removeValue(forKey: id)
            completion(result)
        })
        reads[id] = read
        return read
    }

    func dispose() {
        let pending = Array(reads.values)
        reads.removeAll()
        for read in pending { read.cancel() }
        view = nil
    }
}
