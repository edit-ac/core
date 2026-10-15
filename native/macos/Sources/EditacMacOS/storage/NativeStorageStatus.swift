import Foundation

/// Presentation of the actual shared Session; never a second persistence ledger.
public struct NativeStorageStatus: Sendable {
    public enum Phase: Sendable, Equatable { case closed, pending, committed, recoveryRequired, error }
    public let phase: Phase
    public let snapshot: NativeSessionRead?
    /// Last observed acknowledgment on this owner, absent after restore. The
    /// restored snapshot independently reports the store's durable membership.
    public let receipt: NativeSessionCommit?
    public let failure: NativeSessionFailure?
    public static let closed = NativeStorageStatus(phase: .closed, snapshot: nil, receipt: nil, failure: nil)

    private init(phase: Phase, snapshot: NativeSessionRead?, receipt: NativeSessionCommit?, failure: NativeSessionFailure?) {
        self.phase = phase; self.snapshot = snapshot; self.receipt = receipt; self.failure = failure
    }
    init(read: NativeSessionRead?, receipt: NativeSessionCommit?,
         result: Result<NativeSessionResponse, NativeSessionFailure>, pending: Bool) {
        let failure: NativeSessionFailure?
        if case let .failure(error) = result { failure = error } else { failure = nil }
        self.init(phase: read?.recoveryRequired == true ? .recoveryRequired :
            failure != nil ? .error : pending ? .pending :
            read == nil ? .closed : read?.locallyCommitted == true ? .committed : .pending,
            snapshot: read, receipt: receipt, failure: failure)
    }
    func pending() -> Self {
        Self(phase: .pending, snapshot: snapshot, receipt: receipt, failure: nil)
    }
    public var label: String {
        switch phase {
        case .closed: return "Document closed"
        case .pending: return "Local operation pending"
        case .recoveryRequired: return "Save failed — recovery required"
        case .error: return "Local operation failed"
        case .committed:
            let local: String
            switch snapshot?.localDurability {
            case .processCrash: local = "Saved locally"
            case .volatile: local = "Locally acknowledged (volatile)"
            default: local = "Locally acknowledged (durability unknown)"
            }
            return local + ((snapshot?.pendingUpload ?? 0) > 0 ? " — upload pending" : "")
        }
    }
}
