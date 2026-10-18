import Foundation

/// A detached consumer of the single shared Session revision/diff owner.
/// Disposing a review never disposes its editor's Session or removes revisions.
@MainActor
final class NativeChangeReviewController {
    enum State {
        case idle, loading, ready, disposed
        case unavailable(NativeReviewSide, NativeReviewUnavailable)
        case failed(NativeSessionFailure)
    }
    let view: NativeChangeReviewView
    private let session: NativeSessionExecutor
    private(set) var state: State = .idle
    private var generation: UInt64 = 0
    private var disposed = false
    private var displayedRevision: NativeReviewRevision?

    init(session: NativeSessionExecutor, view: NativeChangeReviewView) {
        self.session = session; self.view = view
    }

    func capture(revision: Data, name: String, requiredKeyProfile: String? = nil,
                 completion: @escaping @MainActor (Result<NativeReviewRevision, NativeSessionFailure>) -> Void) {
        guard !disposed else { completion(.failure(.disposed)); return }
        do {
            try session.submit(.captureReviewRevision(revision: revision, name: name,
                                                      requiredKeyProfile: requiredKeyProfile)) { [weak self] result in
                guard let self, !self.disposed else { return }
                completion(result.flatMap { response in
                    guard case let .reviewRevision(value) = response else { return .failure(.unexpected("Expected review revision")) }
                    return .success(value)
                })
            }
        } catch { completion(.failure(Self.failure(error))) }
    }

    /// Reads labels through the actual revision owner; labels never authenticate an author.
    func compare(before: NativeReviewRevision, after: NativeReviewRevision,
                 beforeKeyProfile: String? = nil, afterKeyProfile: String? = nil,
                 attribution: NativeChangeReviewPresentation.Attribution = .unknown,
                 maxBytes: UInt64 = 16 * 1024 * 1024,
                 completion: (@MainActor () -> Void)? = nil) {
        guard !disposed else { return }
        generation &+= 1
        let ticket = generation
        state = .loading; view.showIssue("Loading immutable revision review")
        request(.readReviewRevision(revision: before, availableKeyProfile: beforeKeyProfile), ticket: ticket, completion: completion) { response in
            guard case let .reviewRead(read) = response else { self.fail(.unexpected("Expected revision read")); completion?(); return }
            guard case let .available(beforeName, _) = read else {
                if case let .unavailable(reason) = read { self.unavailable(.before, reason) }
                completion?(); return
            }
            self.request(.readReviewRevision(revision: after, availableKeyProfile: afterKeyProfile), ticket: ticket, completion: completion) { response in
                guard case let .reviewRead(read) = response else { self.fail(.unexpected("Expected revision read")); completion?(); return }
                guard case let .available(afterName, _) = read else {
                    if case let .unavailable(reason) = read { self.unavailable(.after, reason) }
                    completion?(); return
                }
                self.request(.compareReviewRevisions(before: before, after: after,
                    beforeKeyProfile: beforeKeyProfile, afterKeyProfile: afterKeyProfile, maxBytes: maxBytes), ticket: ticket, completion: completion) { response in
                    switch response {
                    case let .reviewComparison(.unavailable(side, reason)): self.unavailable(side, reason); completion?()
                    case let .reviewComparison(.available(model)):
                        do {
                            // compareReviewRevisions already ran the canonical Rust codec/validator.
                            let presentation = try NativeChangeReviewPresentation.fromSharedValidatedExport(model.json,
                                scope: Self.scope(after), beforeLabel: beforeName, afterLabel: afterName, attribution: attribution)
                            self.displayedRevision = after
                            self.view.show(presentation, current: nil)
                            self.refresh(ticket: ticket, completion: completion)
                        } catch { self.fail(.unexpected("Review presentation: \(error)")); completion?() }
                    default: self.fail(.unexpected("Expected review comparison")); completion?()
                    }
                }
            }
        }
    }

    func refreshCurrent(completion: (@MainActor () -> Void)? = nil) {
        guard !disposed, displayedRevision != nil, case .ready = state else { completion?(); return }
        refresh(ticket: generation, completion: completion)
    }

    private func refresh(ticket: UInt64, completion: (@MainActor () -> Void)?) {
        request(.read(now: 0), ticket: ticket, completion: completion) { response in
            guard case let .snapshot(read) = response, let displayed = self.displayedRevision else {
                self.fail(.unexpected("Expected current Session revision")); completion?(); return
            }
            // Session identity/schema/profile are immutable for this owner. Shared comparison
            // admitted these exact handles. Only its observed live revision can change.
            self.view.observeCurrentScope(read.revision.map { Self.scope(displayed, observed: $0) })
            self.state = .ready; completion?()
        }
    }

    private func request(_ request: NativeSessionRequest, ticket: UInt64,
                         completion: (@MainActor () -> Void)?,
                         receive: @escaping @MainActor (NativeSessionResponse) -> Void) {
        do {
            try session.submit(request) { [weak self] result in
                guard let self, !self.disposed, self.generation == ticket else { return }
                switch result {
                case .success(let response): receive(response)
                case .failure(let failure): self.fail(failure); completion?()
                }
            }
        } catch { fail(Self.failure(error)); completion?() }
    }
    private func unavailable(_ side: NativeReviewSide, _ reason: NativeReviewUnavailable) {
        state = .unavailable(side, reason)
        view.showIssue("Review \(side) revision unavailable: \(reason) — historical review retained")
    }
    private func fail(_ failure: NativeSessionFailure) {
        state = .failed(failure)
        view.showIssue("Review failed: \(failure) — historical review retained")
    }
    private static func failure(_ error: Error) -> NativeSessionFailure {
        (error as? NativeSessionFailure) ?? .unexpected(String(describing: error))
    }
    private static func scope(_ revision: NativeReviewRevision, observed: Data? = nil) -> NativeChangeReviewScope {
        .init(document: revision.documentId, epoch: revision.epoch, schema: revision.schema,
              profile: revision.moduleProfile, revision: observed ?? revision.observedRevision)
    }
    func dispose() {
        guard !disposed else { return }
        disposed = true; generation &+= 1; displayedRevision = nil; state = .disposed; view.dispose()
    }
}
