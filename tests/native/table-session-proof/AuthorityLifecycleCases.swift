import Foundation

// Local disposable host, directly executing the existing Rust security fixtures.
// This is neither an exported native security adapter nor production encryption.
final class PreparedAuthorityHost {
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    let trace: FileHandle
    init(_ session: NativeSession) throws {
        let index = CommandLine.arguments.firstIndex(of: "--authority-fixture")!
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        process.standardInput = input
        process.standardOutput = output
        let path = options().path + ".authority"
        FileManager.default.createFile(atPath: path + ".jsonl", contents: nil)
        trace = try FileHandle(forWritingTo: URL(fileURLWithPath: path + ".jsonl"))
        FileManager.default.createFile(atPath: path + ".stderr", contents: nil)
        process.standardError = try FileHandle(forWritingTo: URL(fileURLWithPath: path + ".stderr"))
        try process.run()
        do {
            let reply = try request(["action":"start", "identity":wire(session.richSnapshot().snapshotJson)["identity"]!, "relayPath":path + ".sqlite"])
            try require(reply["status"] as? String == "started" && reply["productionEncryptionQualified"] as? Bool == false, "prepared fixture start")
        } catch {
            try? input.fileHandleForWriting.close()
            process.waitUntilExit()
            throw error
        }
    }
    deinit {
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()
        try? trace.close()
    }
    func request(_ request: [String:Any]) throws -> [String:Any] {
        var bytes = try JSONSerialization.data(withJSONObject:request,options:[.sortedKeys])
        bytes.append(10)
        try input.fileHandleForWriting.write(contentsOf:bytes)
        var response = Data()
        while true {
            let byte = try output.fileHandleForReading.read(upToCount:1) ?? Data()
            try require(!byte.isEmpty,"fixture terminated before reply")
            if byte[0] == 10 {break}
            response.append(byte)
            try require(response.count <= 2*1024*1024,"bounded fixture reply")
        }
        try trace.write(contentsOf:response + Data([10]))
        return try wire(String(data:response,encoding:.utf8)!)
    }
    func admit(_ entry: NativeSessionPeerUpdate?, key: String = "ready", authorized: Bool = true, tamper: Bool = false) throws -> [String:Any] {
        var request: [String:Any] = ["action":"admit","key":key,"authorized":authorized,"tamper":tamper]
        if let e = entry {
            request["update"] = ["identity":try wire(e.identityJson),"writer":e.writer,"sequence":e.sequence,
                                 "checksum":e.checksum.map {Int($0)},"origin":e.origin,"bytes":e.bytes.map {Int($0)}]
        }
        return try self.request(request)
    }
    func update(_ response: [String:Any]) throws -> NativeSessionPeerUpdate {
        try require(response["status"] as? String == "admitted","host admission required")
        let e = response["update"] as! [String:Any]
        return NativeSessionPeerUpdate(identityJson:String(data:try JSONSerialization.data(withJSONObject:e["identity"]!,options:[.sortedKeys]),encoding:.utf8)!,
            writer:(e["writer"] as! NSNumber).uint32Value,sequence:(e["sequence"] as! NSNumber).uint64Value,
            checksum:Data((e["checksum"] as! [NSNumber]).map {$0.uint8Value}),origin:e["origin"] as! String,
            bytes:Data((e["bytes"] as! [NSNumber]).map {$0.uint8Value}))
    }
}

func runAuthorityLifecycleCases() {
    test("authority-key-real-mls-native-distinct-sqlite-denial-revoke-rejoin-receipts") {
        let (lo,left) = try tableSession();let (ro,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        try require(lo.path != ro.path,"distinct stores")
        try right.setTablePolicy(enabled:true)
        let host = try PreparedAuthorityHost(left)
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let rt = try right.attachHostTransport(options:hostOptions(right),now:0)
        _ = try commandApply(right,tableCommand(right,"authenticated host 🦀"))
        let entry = try right.pendingUpdates()[0]
        try left.reservePeerWriter(writer:entry.writer)
        let before = try left.read(now:0).revision!
        for (key,authorized,reason) in [("ready",false,"authority"),("locked",true,"Locked"),("revoked",true,"Revoked"),("unavailable",true,"Unavailable"),("foreign",true,"Context")] {
            let denied = try host.admit(entry,key:key,authorized:authorized)
            try require(denied["status"] as? String == "denied" && denied["reason"] as? String == reason,"precise independent admission: " + reason)
            try require(left.read(now:0).revision! == before && left.pendingUpdates().isEmpty,"denial never reaches live native model")
        }
        let admitted = try host.admit(entry)
        try require((admitted["acquisitions"] as! Int) == 5,"every key operation reacquired; authority denial acquired none")
        try require((admitted["ciphertextBytes"] as! Int) > 0,"real MLS ciphertext")
        let received = try host.update(admitted)
        try require(received.bytes == entry.bytes && received.checksum == entry.checksum,"exact authenticated journal payload")
        let commit = try left.receiveHostPeer(token:lt,update:received,now:0)
        try require(commit.durability == .processCrash && commit.checksum == entry.checksum,"actual SQLite receipt")
        try require(equivalent(visible(left)[1],visible(right)[1]),"admitted live convergence")
        try require(right.pendingUpdates().count == 1,"ciphertext storage is not a semantic durable receipt")
        try require(right.acceptHostReceipt(token:rt,receipt:hostReceipt(entry),now:0) == .remoteCommitted,"exact authenticated application receipt")
        try left.detachHostTransport(token:lt)
        try hostDenied {_ = try left.receiveHostPeer(token:lt,update:received,now:0)}
        try require(try host.admit(nil,key:"revoked")["status"] as? String == "denied","login/lease cannot supply key access")
        try require(try host.admit(nil)["status"] as? String == "authorized","explicit fresh key acquisition for rejoin")
        let next = try left.attachHostTransport(options:hostOptions(left,expiry:200),now:100)
        try hostDenied {_ = try left.receiveHostPeer(token:lt,update:received,now:100)}
        _ = try left.receiveHostPeer(token:next,update:received,now:100)
        try require(left.historyState(now:100).undoGroups == 0,"idempotent rejoin preserves history")
        try hostDenied {_ = try left.receiveHostPeer(token:next,update:received,now:200)}
        try left.dispose()
        let reopened = try NativeSession.open(options:lo);defer {try? reopened.dispose()}
        try require(equivalent(visible(reopened)[1],visible(right)[1]),"admitted update durable after reopen")
    }
    test("authority-key-authentication-failure-retires-prepared-client-without-native-mutation") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        try right.setTablePolicy(enabled:true)
        let host = try PreparedAuthorityHost(left)
        _ = try commandApply(right,tableCommand(right,"must authenticate"))
        let e = try right.pendingUpdates()[0]
        let before = try left.read(now:0).revision!
        let bad = try host.admit(e,tamper:true)
        try require(bad["status"] as? String == "denied" && bad["reason"] as? String == "Authentication","owning MLS authentication rejects altered bytes")
        let retired = try host.admit(e)
        try require(retired["status"] as? String == "denied" && retired["reason"] as? String == "Locked","failed MLS state requires fresh rejoin")
        try require(left.read(now:0).revision! == before && left.pendingUpdates().isEmpty,"security denial never entered native semantic path")
    }
    test("lifecycle-remote-overlapping-staged-input-stale-rebase-undo-preserves-remote") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let host = try PreparedAuthorityHost(left)
        let node = try visible(left)[0]["id"] as! String
        let before = try left.read(now:0).revision!
        let staged = try left.prepareEdits(revision:before,edits:[NativeSessionEdit(node:node,fromUtf16:0,toUtf16:0,text:"LOCAL 😀")],origin:"composition",now:0)
        let remote = try right.prepareEdits(revision:right.read(now:0).revision!,edits:[NativeSessionEdit(node:node,fromUtf16:0,toUtf16:0,text:"REMOTE ")],origin:"remote",now:0)
        _ = try right.commitEdits(token:remote,now:0)
        let entry = try right.pendingUpdates()[0]
        try left.reservePeerWriter(writer:entry.writer)
        _ = try left.receiveHostPeer(token:lt,update:host.update(host.admit(entry)),now:0)
        try expect({if case .Revision(reason:.stale,message:_) = $0 {return true};return false}) {_ = try left.commitEdits(token:staged,now:0)}
        try left.cancelEdits(token:staged)
        let remoteText = try nodeText(visible(left)[0])
        try require(remoteText.hasPrefix("REMOTE ") && !remoteText.contains("LOCAL"),"staged composition never leaked")
        let rebased = try left.prepareEdits(revision:left.read(now:0).revision!,edits:[NativeSessionEdit(node:node,fromUtf16:0,toUtf16:0,text:"LOCAL 😀")],origin:"composition",now:0)
        _ = try left.commitEdits(token:rebased,now:0)
        try require(nodeText(visible(left)[0]).hasPrefix("LOCAL 😀REMOTE "),"explicit current-revision input commit")
        _ = try left.undo(revision:left.read(now:0).revision!,now:0)
        try require(nodeText(visible(left)[0]) == remoteText,"local undo preserves overlapping remote input")
        _ = try left.redo(revision:left.read(now:0).revision!,now:0)
        try require(nodeText(visible(left)[0]).hasPrefix("LOCAL 😀REMOTE "),"local redo")
    }
    test("lifecycle-document-switch-cancel-queued-input-and-late-host-events") {
        let (_,old) = try tableSession();let (_,peer) = try tableSession()
        defer {try? old.dispose();try? peer.dispose()}
        let token = try old.attachHostTransport(options:hostOptions(old),now:0)
        let staged = try commandPlan(old,[["type":"replaceAt","owner":visible(old)[0]["id"]!,"from":0,"to":0,"text":"never commit"]])
        try old.cancelCommands(token:staged.token)
        try old.detachHostTransport(token:token)
        try old.dispose()
        let next = try create(options());defer {try? next.dispose()}
        let nextToken = try next.attachHostTransport(options:hostOptions(next),now:0)
        let before = try next.read(now:0).revision!
        try expect({if case .Disposed = $0 {return true};return false}) {_ = try old.commitCommands(token:staged.token,now:0)}
        try expect({if case .Disposed = $0 {return true};return false}) {_ = try old.takeHostFrames(token:token,maxFrames:1,now:0)}
        try hostDenied {try next.detachHostTransport(token:token)}
        try hostDenied {_ = try next.takeHostFrames(token:token,maxFrames:1,now:0)}
        let pt = try peer.attachHostTransport(options:hostOptions(peer),now:0)
        let frame = try announcePresence(peer,pt,presenceAnchors(peer))
        try expect({if case .Incompatible = $0 {return true};return false}) {try next.receiveHostPresence(token:nextToken,frame:frame,now:0)}
        try require(next.read(now:0).revision! == before && next.pendingUpdates().isEmpty && next.hostPresence(token:nextToken,now:0).isEmpty,"document switch isolates all delayed work")
    }
    test("lifecycle-host-event-reentry-after-return-and-generation-recheck") {
        let (_,left) = try tableSession();let (_,right) = try tableSession()
        defer {try? left.dispose();try? right.dispose()}
        try right.setTablePolicy(enabled:true)
        let lt = try left.attachHostTransport(options:hostOptions(left),now:0)
        let host = try PreparedAuthorityHost(left)
        _ = try commandApply(right,tableCommand(right,"reentrant host event"))
        let e = try right.pendingUpdates()[0]
        try left.reservePeerWriter(writer:e.writer)
        let update = try host.update(host.admit(e))
        let receipt = try left.receiveHostPeer(token:lt,update:update,now:0)
        let committedRevision = try left.read(now:0).revision!
        // The shared adapter installs no foreign callbacks. A host completion
        // event may immediately read, revoke and rejoin after the call returns.
        let completion = { () throws -> String in
            try require(left.read(now:0).revision == committedRevision && receipt.checksum == e.checksum,"completion sees durable state")
            try left.detachHostTransport(token:lt)
            return try left.attachHostTransport(options:hostOptions(left),now:0)
        }
        let replacement = try completion()
        try hostDenied {_ = try left.receiveHostPeer(token:lt,update:update,now:0)}
        _ = try left.receiveHostPeer(token:replacement,update:update,now:0)
        try require(left.historyState(now:0).undoGroups == 0,"completion reentry cannot duplicate remote admission")
    }
}
