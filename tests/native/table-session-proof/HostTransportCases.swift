import Foundation

func hostOptions(_ s: NativeSession, expiry: UInt64 = 100, receipts: Bool = true,
                 frames: UInt32 = 32) throws -> NativeHostTransportOptions {
    let identity = try wire(s.richSnapshot().snapshotJson)["identity"]!
    let json = String(data: try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]), encoding: .utf8)!
    return NativeHostTransportOptions(identityJson:json, expiresAt:expiry, durableReceipts:receipts,
        maxFrameBytes:1048576, maxQueueBytes:2097152, maxQueueFrames:frames)
}
func hostReceipt(_ e: NativeSessionPeerUpdate) -> NativeHostReceipt {
    NativeHostReceipt(identityJson:e.identityJson, writer:e.writer, sequence:e.sequence, checksum:e.checksum)
}
func hostDenied(_ op: () throws -> Void) throws {
    try expect({if case .Unauthorized = $0 {return true};return false}, op)
}
func runHostTransportCases() {
    for (name,tableIndex,structural) in [("v1-cell",1,false),("v2-cell",2,false),("v1-column",1,true)] {
        test("host-transport-distinct-sqlite-" + name + "-reconnect-receipt-history-reopen") {
            let (o,left) = try tableSession();let (_,right) = try tableSession()
            defer {try? left.dispose();try? right.dispose()}
            try right.setTablePolicy(enabled:true)
            let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
            let rt = try right.attachHostTransport(options:hostOptions(right),now:0)
            let table = try visible(right)[tableIndex]
            let c: [[String:Any]] = structural
                ? [["type":"tableStructure","owner":table["id"]!,"expected":table["blockAttributes"]!,"action":"insertColumn","index":1]]
                : [["type":"tableCell","owner":table["id"]!,"expected":table["blockAttributes"]!,"row":0,"column":0,"text":"Transport 🦀אב"]]
            let committed = try commandApply(right,c)
            let e = try right.pendingUpdates().first {$0.writer == committed.writer && $0.sequence == committed.sequence}!
            try left.reservePeerWriter(writer:e.writer)
            try require(right.flushHostTransport(token:rt,now:0) == 1,"actual Session flush")
            let frames = try right.takeHostFrames(token:rt,maxFrames:32,now:0)
            try require(frames.count == 1 && frames[0].bytes.first == 2 && frames[0].bytes.suffix(e.bytes.count) == e.bytes,"existing wire bytes")
            try require(right.pendingUpdates().count == 1,"send is not receipt")
            let receipt = try left.receiveHostPeer(token:lt,update:e,now:0)
            try require(receipt.checksum == e.checksum && receipt.durability == .processCrash,"actual committed SQLite receipt")
            try require(equivalent(visible(left)[tableIndex],visible(right)[tableIndex]),"distinct store convergence")
            try right.detachHostTransport(token:rt)
            let replacement = try right.attachHostTransport(options:hostOptions(right),now:1)
            try require(replacement != rt,"fresh scope")
            try hostDenied { _ = try right.flushHostTransport(token:rt,now:1) }
            try hostDenied {try right.detachHostTransport(token:rt)}
            try require(right.flushHostTransport(token:replacement,now:1) == 1,"durable replay")
            _ = try left.receiveHostPeer(token:lt,update:e,now:1)
            try require(left.historyState(now:1).undoGroups == 0,"remote replay does not create local history")
            try require(right.acceptHostReceipt(token:replacement,receipt:hostReceipt(e),now:1) == .remoteCommitted,"authenticated exact ack")
            try require(right.pendingUpdates().isEmpty,"ack prunes")
            try require(right.acceptHostReceipt(token:replacement,receipt:hostReceipt(e),now:1) == .remoteCommitted,"idempotent ack")
            try left.dispose()
            let reopened = try NativeSession.open(options:o);defer {try? reopened.dispose()}
            try require(equivalent(visible(reopened)[tableIndex],visible(right)[tableIndex]),"durable reopen")
        }
    }
    test("host-transport-lease-expiry-revocation-rejoin-readonly-and-late-dispose") {
        let (_,s) = try tableSession();let (_,peer) = try tableSession()
        defer {try? s.dispose();try? peer.dispose()}
        try peer.setTablePolicy(enabled:true)
        _ = try commandApply(peer,tableCommand(peer,"leased remote"))
        let e = try peer.pendingUpdates()[0]
        try s.reservePeerWriter(writer:e.writer)
        let token = try s.attachHostTransport(options:hostOptions(s),now:0)
        try require(s.flushHostTransport(token:token,now:99) == 0,"before exclusive expiry")
        try hostDenied {_ = try s.flushHostTransport(token:token,now:100)}
        try hostDenied {_ = try s.takeHostFrames(token:token,maxFrames:1,now:100)}
        try hostDenied {_ = try s.receiveHostPeer(token:token,update:e,now:100)}
        try hostDenied {_ = try s.acceptHostReceipt(token:token,receipt:hostReceipt(e),now:100)}
        try s.detachHostTransport(token:token)
        let next = try s.attachHostTransport(options:hostOptions(s,expiry:200),now:100)
        try s.setPermission(writable:false,expiresAt:nil)
        _ = try s.receiveHostPeer(token:next,update:e,now:100)
        try require(!s.read(now:100).canApply,"lease does not grant local edit")
        try s.dispose()
        try expect({if case .Disposed = $0 {return true};return false}) {_ = try s.takeHostFrames(token:next,maxFrames:1,now:100)}
    }
    test("host-transport-backpressure-exact-receipt-capability-and-invalid-attach") {
        let (_,s) = try tableSession();defer {try? s.dispose()}
        try s.setTablePolicy(enabled:true)
        _ = try commandApply(s,tableCommand(s,"one"));_ = try commandApply(s,tableCommand(s,"two"))
        let e = try s.pendingUpdates()[0]
        let token = try s.attachHostTransport(options:hostOptions(s,receipts:false,frames:1),now:0)
        try expect({if case .Store(reason:.backpressure) = $0 {return true};return false}) {_ = try s.flushHostTransport(token:token,now:0)}
        try require(s.takeHostFrames(token:token,maxFrames:32,now:0).count == 1,"accepted prefix retained")
        try require(s.pendingUpdates().count == 2,"no queue drop of durable work")
        try require(s.acceptHostReceipt(token:token,receipt:hostReceipt(e),now:0) == .capabilityUnavailable,"negotiated capability required")
        var invalid = try hostOptions(s);invalid.identityJson = "{}"
        try expect({if case .Incompatible = $0 {return true};return false}) {_ = try s.attachHostTransport(options:invalid,now:0)}
        try require(s.takeHostFrames(token:token,maxFrames:32,now:0).isEmpty,"invalid attach preserves current connection")
        let next = try s.attachHostTransport(options:hostOptions(s),now:0)
        var wrong = hostReceipt(e);wrong.sequence += 999
        try require(s.acceptHostReceipt(token:next,receipt:wrong,now:0) == .unknownUpdate,"unknown receipt cannot prune")
        try require(s.pendingUpdates().count == 2,"exact identity required")
        try require(s.acceptHostReceipt(token:next,receipt:hostReceipt(e),now:0) == .remoteCommitted,"actual exact receipt")
        try require(s.pendingUpdates().count == 1,"only matching entry pruned")
    }
    test("host-transport-page-larger-than-queue-without-receipts") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        try right.setTablePolicy(enabled:true)
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let rt = try right.attachHostTransport(options:hostOptions(right,receipts:false,frames:1),now:0)
        for text in ["first","second","third"] {_ = try commandApply(right,tableCommand(right,text))}
        let entries = try right.pendingUpdates()
        try require(entries.count == 3,"real committed backlog")
        try left.reservePeerWriter(writer:entries[0].writer)
        var cursor: NativeHostReceipt? = nil
        for e in entries {
            try require(right.flushHostTransportPage(token:rt,after:cursor,maxFrames:1,now:0) == 1,"bounded progress")
            let frames = try right.takeHostFrames(token:rt,maxFrames:1,now:0)
            try require(frames.count == 1 && frames[0].bytes.suffix(e.bytes.count) == e.bytes,"correct next actual update")
            _ = try left.receiveHostPeer(token:lt,update:e,now:0)
            cursor = hostReceipt(e)
        }
        try require(right.flushHostTransportPage(token:rt,after:cursor,maxFrames:1,now:0) == 0,"exhausted page")
        try require(right.pendingUpdates().count == 3,"paging never acknowledges")
        try require(equivalent(visible(left)[1],visible(right)[1]),"actual native convergence through full backlog")
    }

}
