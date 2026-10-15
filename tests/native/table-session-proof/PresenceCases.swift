import Foundation

func presenceAnchors(_ s: NativeSession, index: Int = 0) throws -> [NativeSessionAnchor] {
    let owner = try visible(s)[index]["id"] as! String
    return try s.captureAnchors(revision:s.read(now:0).revision!,inputs:[
        AnchorInput(node:owner,offsetUtf16:0,bias:.left),AnchorInput(node:owner,offsetUtf16:0,bias:.right)])
}
func announcePresence(_ s: NativeSession, _ token: String, _ anchors: [NativeSessionAnchor], now: UInt64 = 0) throws -> NativeHostFrame {
    try s.setHostPresence(token:token,anchor:anchors[0].token,focus:anchors[1].token,present:true,now:now)
    try require(s.flushHostPresence(token:token,now:now),"presence flush")
    return try s.takeHostPresenceFrames(token:token,maxFrames:1,now:now)[0]
}
func runPresenceCases() {
    test("presence-distinct-sqlite-current-selection-remote-structure-ephemeral") {
        let (lo,left) = try tableSession();let (ro,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        try require(lo.path != ro.path,"independent stores")
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let rt = try right.attachHostTransport(options:hostOptions(right),now:0)
        let before = try left.read(now:0).revision!
        let frame = try announcePresence(right,rt,presenceAnchors(right,index:1))
        try left.receiveHostPresence(token:lt,frame:frame,now:0)
        let peers = try left.hostPresence(token:lt,now:0)
        try require(peers.count==1 && peers[0].selection != nil,"actual remote selection")
        if case .position(let node,_,_,_,_) = peers[0].selection!.anchor {
            try require(node == visible(left)[1]["id"] as! String,"same table owner")
        } else {throw NSError(domain:"presence-selection",code:1)}
        try require(left.read(now:0).revision! == before && left.pendingUpdates().isEmpty,"ephemeral only")
        try require(right.takeHostFrames(token:rt,maxFrames:1,now:0).isEmpty,"separate sync queue")
        try right.setTablePolicy(enabled:true)
        let table = try visible(right)[1]
        let commit = try commandApply(right,[["type":"tableStructure","owner":table["id"]!,"expected":table["blockAttributes"]!,"action":"insertColumn","index":1]])
        let entry = try right.pendingUpdates().first {$0.writer==commit.writer && $0.sequence==commit.sequence}!
        try left.reservePeerWriter(writer:entry.writer)
        _ = try left.receiveHostPeer(token:lt,update:entry,now:0)
        try require(left.hostPresence(token:lt,now:1)[0].selection != nil,"current shared resolution")
    }
    test("presence-expiry-renewal-leave-stale-frame-tombstone") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        let lt = try left.attachHostTransport(options:hostOptions(left,expiry:100000),now:0)
        let rt = try right.attachHostTransport(options:hostOptions(right,expiry:100000),now:0)
        let frame = try announcePresence(right,rt,presenceAnchors(right))
        try left.receiveHostPresence(token:lt,frame:frame,now:0)
        try require(left.hostPresence(token:lt,now:29999).count==1,"not expired")
        try require(left.hostPresence(token:lt,now:30000).isEmpty,"expired")
        try left.receiveHostPresence(token:lt,frame:frame,now:30000)
        try require(left.hostPresence(token:lt,now:30000).isEmpty,"duplicate cannot resurrect")
        try require(right.flushHostPresence(token:rt,now:30000),"renew")
        let renewed = try right.takeHostPresenceFrames(token:rt,maxFrames:1,now:30000)[0]
        try left.receiveHostPresence(token:lt,frame:renewed,now:30001)
        try require(left.hostPresence(token:lt,now:30001).count==1,"renewed")
        try right.setHostPresence(token:rt,anchor:nil,focus:nil,present:false,now:30050)
        try require(right.flushHostPresence(token:rt,now:30050),"leave")
        let leave = try right.takeHostPresenceFrames(token:rt,maxFrames:1,now:30050)[0]
        try left.receiveHostPresence(token:lt,frame:leave,now:30050)
        try left.receiveHostPresence(token:lt,frame:renewed,now:30051)
        try require(left.hostPresence(token:lt,now:30051).isEmpty,"leave tombstone")
    }
    test("presence-denial-readonly-revocation-rejoin-document-switch-late-disposal") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let rt = try right.attachHostTransport(options:hostOptions(right),now:0)
        let anchors = try presenceAnchors(right)
        let frame = try announcePresence(right,rt,anchors)
        try left.setPermission(writable:false,expiresAt:0)
        try left.receiveHostPresence(token:lt,frame:frame,now:1)
        try require(left.hostPresence(token:lt,now:1).count==1,"read-only presence")
        try expect({if case .InvalidAnchor = $0 {return true};return false}) {
            try left.setHostPresence(token:lt,anchor:anchors[0].token,focus:anchors[1].token,present:true,now:1)
        }
        try left.detachHostTransport(token:lt)
        let replacement = try left.attachHostTransport(options:hostOptions(left),now:1)
        try hostDenied {try left.receiveHostPresence(token:lt,frame:frame,now:1)}
        try hostDenied {try left.detachHostTransport(token:lt)}
        try hostDenied {_ = try right.hostPresence(token:replacement,now:1)}
        try require(left.hostPresence(token:replacement,now:1).isEmpty,"connection state reset")
        try hostDenied {_ = try left.hostPresence(token:replacement,now:100)}
        try left.dispose()
        try expect({if case .Disposed = $0 {return true};return false}) {_ = try left.hostPresence(token:replacement,now:1)}
    }
    test("presence-malformed-scope-frame-and-time-reject-without-mutation") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let rt = try right.attachHostTransport(options:hostOptions(right),now:0)
        let frame = try announcePresence(right,rt,presenceAnchors(right))
        let before = try left.read(now:0).revision!
        for bytes in [Data(),Data([0,0]),Data(repeating:255,count:65537)] {
            do {try left.receiveHostPresence(token:lt,frame:NativeHostFrame(identityJson:frame.identityJson,bytes:bytes),now:1);throw NSError(domain:"bad-frame-accepted",code:1)}
            catch is NativeSessionError {}
        }
        try expect({if case .Incompatible = $0 {return true};return false}) {
            try left.receiveHostPresence(token:lt,frame:NativeHostFrame(identityJson:"{}",bytes:frame.bytes),now:1)
        }
        try left.receiveHostPresence(token:lt,frame:frame,now:2)
        try expect({if case .AnchorTarget = $0 {return true};return false}) {_ = try left.hostPresence(token:lt,now:1)}
        try require(left.read(now:0).revision! == before && left.pendingUpdates().isEmpty,"no mutations")
    }
    test("presence-pending-input-cancel-and-committed-selection-stay-independent") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let rt = try right.attachHostTransport(options:hostOptions(right),now:0)
        let before = try left.read(now:0).revision!
        let paragraph = try visible(left)[0]["id"] as! String
        let plan = try left.prepareEdits(revision:before,edits:[NativeSessionEdit(node:paragraph,fromUtf16:0,toUtf16:0,text:"uncommitted 😀")],origin:"staged-input",now:0)
        let frame = try announcePresence(right,rt,presenceAnchors(right))
        try left.receiveHostPresence(token:lt,frame:frame,now:0)
        try require(left.read(now:0).revision! == before,"presence cannot commit staged input")
        try left.cancelEdits(token:plan)
        try require(left.read(now:0).revision! == before && left.pendingUpdates().isEmpty,"cancel is inert")
        try require(left.hostPresence(token:lt,now:0).count==1,"presence retained independently")
    }
    test("presence-coalesced-bounded-queue-retries-and-configured-limit-is-precise") {
        let (_,left) = try tableSession();defer {try? left.dispose()}
        let token = try left.attachHostTransport(options:hostOptions(left,expiry:1000,frames:1),now:0)
        try left.setHostPresence(token:token,anchor:nil,focus:nil,present:true,now:0)
        try require(left.flushHostPresence(token:token,now:0),"first send")
        try left.setHostPresence(token:token,anchor:nil,focus:nil,present:false,now:1)
        try require(!left.flushHostPresence(token:token,now:1),"throttled")
        try require(!left.flushHostPresence(token:token,now:50),"backpressure")
        try require(left.takeHostPresenceFrames(token:token,maxFrames:1,now:50).count==1,"drain prefix")
        try require(left.flushHostPresence(token:token,now:100),"retry retained leave")
        try left.detachHostTransport(token:token)
        let identity = try hostOptions(left).identityJson
        let limited = try left.attachHostTransport(options:NativeHostTransportOptions(identityJson:identity,expiresAt:1000,durableReceipts:false,maxFrameBytes:1,maxQueueBytes:1,maxQueueFrames:1),now:100)
        try left.setHostPresence(token:limited,anchor:nil,focus:nil,present:true,now:100)
        try expect({if case .Store(reason:.resourceLimit) = $0 {return true};return false}) {_ = try left.flushHostPresence(token:limited,now:100)}
        try require(left.takeHostPresenceFrames(token:limited,maxFrames:1,now:100).isEmpty,"oversize never queued")
    }

}
