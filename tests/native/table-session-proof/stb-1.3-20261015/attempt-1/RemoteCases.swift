import Foundation

// Deterministic trusted hosts exchange exact committed entries after admission.
// These are distinct SQLite stores, with no network or cryptographic claim.
func runRemoteCases() {
    for (name, tableIndex, structural) in [("v1-cell",1,false),("v2-cell",2,false),("v1-structure",1,true)] {
        test("remote-generated-distinct-sqlite-" + name + "-history-stale-reopen") {
            let (localOptions, local) = try tableSession()
            let (peerOptions, peer) = try tableSession()
            defer {try? local.dispose();try? peer.dispose()}
            try require(localOptions.path != peerOptions.path,"distinct stores")
            try local.setTablePolicy(enabled:true);try peer.setTablePolicy(enabled:true)
            let paragraph = try visible(local)[0]["id"] as! String
            let edit = try local.prepareEdits(revision:local.read(now:0).revision!,edits:[NativeSessionEdit(node:paragraph,fromUtf16:0,toUtf16:0,text:"LOCAL ")],origin:"local-typing",now:0)
            let localCommit = try local.commitEdits(token:edit,now:0)!
            try expect({if case .Store(reason: .Permission) = $0 {return true};return false}) {try local.reservePeerWriter(writer:localCommit.writer)}
            let stale = try commandPlan(local,tableCommand(local,"stale"))
            let oldRevision = try local.read(now:0).revision!
            let anchor = try local.captureAnchors(revision:oldRevision,inputs:[AnchorInput(node:paragraph,offsetUtf16:1,bias:.right)])[0]
            let projection = try local.richSnapshot()
            let table = try visible(peer)[tableIndex]
            let command: [[String:Any]] = structural
                ? [["type":"tableStructure","owner":table["id"]!,"expected":table["blockAttributes"]!,"action":"insertColumn","index":1]]
                : [["type":"tableCell","owner":table["id"]!,"expected":table["blockAttributes"]!,"row":0,"column":0,"text":"REMOTE 🦀אב"]]
            let peerCommit = try commandApply(peer,command)
            let entry = try peer.pendingUpdates().first {$0.writer == peerCommit.writer && $0.sequence == peerCommit.sequence}!
            try local.reservePeerWriter(writer:entry.writer)
            let receipt = try local.receivePeer(update:entry)
            try require(receipt.writer == entry.writer && receipt.sequence == entry.sequence && receipt.checksum == entry.checksum && receipt.durability == .processCrash,"exact durable local receipt")
            let patches = try local.takeRichPatches(afterSequence:projection.sequence)
            try require(!patches.patchesJson.isEmpty && patches.revision != oldRevision,"live projection invalidation")
            try require(local.resolveAnchor(token:anchor.token).revision == patches.revision,"anchor revision invalidation")
            try expect({if case .Revision(reason:.stale,message:_) = $0 {return true};return false}) {_ = try local.commitCommands(token:stale.token,now:0)}
            let after = try visible(local)
            try require(equivalent(after[tableIndex],try visible(peer)[tableIndex]),"actual table convergence")
            try history(local,undo:1,redo:0)
            _ = try local.undo(revision:local.read(now:0).revision!,now:0)
            let undone = try visible(local)
            try require(equivalent(undone[tableIndex],after[tableIndex]) && !String(describing:undone[0]["runs"]!).contains("LOCAL"),"local undo retains remote")
            _ = try local.redo(revision:local.read(now:0).revision!,now:0)
            try require(equivalent(try visible(local),after),"local redo retains remote")
            let duplicateRevision = try local.read(now:0).revision!
            _ = try local.receivePeer(update:entry)
            try require(local.read(now:0).revision == duplicateRevision,"idempotent duplicate")
            try local.dispose()
            let reopened = try NativeSession.open(options:localOptions);defer{try? reopened.dispose()}
            try require(equivalent(try visible(reopened),after),"remote durable reopen")
            try expect({if case .InvalidAnchor = $0 {return true};return false}) {_ = try reopened.resolveAnchor(token:anchor.token)}
            _ = try reopened.receivePeer(update:entry) // persistent peer reservation
            try expect({if case .Disposed = $0 {return true};return false}) {_ = try local.receivePeer(update:entry)}
        }
    }
    test("remote-generated-guards-readonly-disposal-owned-records") {
        let (_,local)=try tableSession();let (_,peer)=try tableSession()
        defer{try? local.dispose();try? peer.dispose()}
        try peer.setTablePolicy(enabled:true)
        let commit=try commandApply(peer,tableCommand(peer,"REMOTE"))
        let entry=try peer.pendingUpdates().first{$0.writer==commit.writer}!
        let before=try visible(local),revision=try local.read(now:0).revision!
        var bad=entry;bad.checksum[0] ^= 1
        try expect({if case .Store(reason:.Integrity) = $0 {return true};return false}) {_ = try local.receivePeer(update:bad)}
        bad=entry;bad.identityJson="{}"
        try expect({if case .Incompatible = $0 {return true};return false}) {_ = try local.receivePeer(update:bad)}
        bad=entry;bad.sequence=0
        try expect({if case .Store(reason:.InvalidRecord) = $0 {return true};return false}) {_ = try local.receivePeer(update:bad)}
        try require(equivalent(try visible(local),before) && local.read(now:0).revision==revision,"invalid record mutated")
        try expect({if case .Store(reason:.Permission) = $0 {return true};return false}) {_ = try local.receivePeer(update:entry)}
        try require(local.read(now:0).recoveryRequired,"unreserved admission freezes")
        try expect({if case .RecoveryRequired = $0 {return true};return false}) {_ = try local.pendingUpdates()}
        try local.recover();try local.reservePeerWriter(writer:entry.writer)
        try expect({if case .Store(reason:.Conflict) = $0 {return true};return false}) {try local.reservePeerWriter(writer:entry.writer)}
        try local.setPermission(writable:false,expiresAt:0)
        _ = try local.receivePeer(update:entry)
        try require(equivalent(try visible(local)[1],try visible(peer)[1]) && !local.read(now:1).canApply,"host admitted receive independent of local write permission")
        try peer.dispose()
        try require(entry.bytes.count>0 && entry.checksum.count==32,"owned peer record after disposal")
        try local.dispose()
        try expect({if case .Disposed = $0 {return true};return false}) {_ = try local.pendingUpdates()}
        try expect({if case .Disposed = $0 {return true};return false}) {try local.reservePeerWriter(writer:entry.writer)}
    }
}
