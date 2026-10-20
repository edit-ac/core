import Foundation

func atomicSession() throws -> (NativeSessionOptions, NativeSession) {
    let index = CommandLine.arguments.firstIndex(of: "--attachment-fixture")!
    let manifest = try wire(String(contentsOfFile: CommandLine.arguments[index + 1], encoding: .utf8))
    let path = options().path
    try FileManager.default.copyItem(atPath: manifest["path"] as! String, toPath: path)
    let o = NativeSessionOptions(path:path,documentId:manifest["documentId"] as! String,
        epoch:manifest["epoch"] as! String,writable:true,permissionExpiresAt:nil)
    return (o,try NativeSession.open(options:o))
}
func atomicReplacement(_ index:Int) -> [Any] {
    if index == 1 {return ["module:editac.image",1,["url":"https://assets.example.invalid/new.png","alt":"New 😀","title":"Replacement","source":"![New 😀](https://assets.example.invalid/new.png)"]]}
    return ["module:editac.reference",1,["targetId":"document-new","label":"New reference 😀"]]
}
func atomicCommand(_ s:NativeSession,_ index:Int,_ replacement:Any) throws -> [[String:Any]] {
    let n = try visible(s)[index],owner = n["id"] as! String
    return [["type":"atomicContent","owner":owner,"expected":n["blockAttributes"]!,"at":try commandAnchor(s,owner,0),"replacement":replacement]]
}
func runAtomicContentCases() {
    for index in [1,2] {
        test("atomic-content-generated-replace-remove-history-reopen-\(index)") {
            let (o,s)=try atomicSession();defer{try? s.dispose()}
            try s.setAtomicContentPolicy(images:true,references:true)
            let surrounding=try visible(s)
            _=try commandApply(s,[["type":"markAt","owner":surrounding[0]["id"]!,"from":0,"to":6,"mark":"bold","action":"apply"]])
            _=try commandApply(s,[["type":"markAt","owner":surrounding[3]["id"]!,"from":0,"to":5,"mark":"italic","action":"apply"]])
            let before=try visible(s)
            let p=try commandPlan(s,atomicCommand(s,index,atomicReplacement(index)))
            try require(equivalent(try visible(s),before),"prepare mutated")
            let c=try s.commitCommands(token:p.token,now:0)!
            try require(c.durability == .processCrash,"missing durable receipt")
            let after=try visible(s)
            try require(equivalent(after[index]["blockAttributes"]!,atomicReplacement(index)),"replacement descriptor")
            try require(equivalent(after[index]["id"]!,before[index]["id"]!),"owner changed")
            for i in before.indices where i != index {try require(equivalent(before[i],after[i]),"surrounding content/format changed")}
            _=try s.undo(revision:s.read(now:0).revision!,now:0);try require(equivalent(try visible(s),before),"replace undo")
            _=try s.redo(revision:s.read(now:0).revision!,now:0);try require(equivalent(try visible(s),after),"replace redo")
            _=try commandApply(s,atomicCommand(s,index,NSNull()))
            let removed=try visible(s)
            try require(equivalent(removed[index]["blockAttributes"]!,["paragraph"]) && nodeText(removed[index]).isEmpty,"whole atom removal")
            _=try s.undo(revision:s.read(now:0).revision!,now:0);try require(equivalent(try visible(s),after),"remove undo")
            _=try s.redo(revision:s.read(now:0).revision!,now:0);try require(equivalent(try visible(s),removed),"remove redo")
            try s.dispose();let reopened=try NativeSession.open(options:o);defer{try? reopened.dispose()}
            try require(equivalent(try visible(reopened),removed),"durable reopen")
            try require(!reopened.commandCatalog(now:0).routes.first{$0.id == "atomicContent"}!.available,"policy persisted")
        }
    }
    test("atomic-content-generated-policy-cancel-expiry-invalid-late-and-disposal") {
        let (_,s)=try atomicSession();defer{try? s.dispose()};let before=try visible(s)
        let c=try atomicCommand(s,1,atomicReplacement(1))
        try expect({if case .UnsupportedModule = $0{return true};return false}){_=try commandPlan(s,c)}
        try s.setAtomicContentPolicy(images:true,references:true)
        let catalog=try s.commandCatalog(now:0)
        for id in ["editac.images","editac.references"] {try require(catalog.profiles.contains{$0.id == id && $0.available},"policy profile")}
        let p=try commandPlan(s,c);try s.setAtomicContentPolicy(images:false,references:false)
        try expect({if case .UnsupportedModule = $0{return true};return false}){_=try s.commitCommands(token:p.token,now:0)}
        try s.setAtomicContentPolicy(images:true,references:true)
        let cancelled=try commandPlan(s,c);try s.cancelCommands(token:cancelled.token)
        try expect({if case .InvalidPlan = $0{return true};return false}){_=try s.commitCommands(token:cancelled.token,now:0)}
        let expired=try commandPlan(s,c);try s.setPermission(writable:true,expiresAt:5)
        try expect({_ in true}){_=try s.commitCommands(token:expired.token,now:5)}
        try s.setPermission(writable:false,expiresAt:nil);try expect({_ in true}){_=try commandPlan(s,c)}
        try s.setPermission(writable:true,expiresAt:nil)
        var invalid=c;invalid[0]["replacement"]=["module:editac.image",1,["url":"javascript:alert(1)","alt":"x","title":"","source":"x"]]
        try expect({_ in true}){_=try commandPlan(s,invalid)}
        try require(equivalent(try visible(s),before),"rejection mutated")
        let late=try commandPlan(s,c);try s.dispose()
        try expect({if case .Disposed = $0{return true};return false}){_=try s.commitCommands(token:late.token,now:0)}
    }
    test("atomic-content-generated-distinct-store-remote-stale-history") {
        let (_,s)=try atomicSession(),(_,peer)=try atomicSession();defer{try? s.dispose();try? peer.dispose()}
        try s.setAtomicContentPolicy(images:true,references:true);try peer.setAtomicContentPolicy(images:true,references:true)
        let stale=try commandPlan(s,atomicCommand(s,1,atomicReplacement(1)))
        let c=try commandApply(peer,atomicCommand(peer,2,atomicReplacement(2)))
        let entry=try peer.pendingUpdates().first{$0.writer == c.writer && $0.sequence == c.sequence}!
        try s.reservePeerWriter(writer:entry.writer);_=try s.receivePeer(update:entry)
        let remote=try visible(s);try require(equivalent(remote,try visible(peer)),"cross-store convergence")
        try expect({_ in true}){_=try s.commitCommands(token:stale.token,now:0)}
        _=try commandApply(s,atomicCommand(s,1,NSNull()))
        _=try s.undo(revision:s.read(now:0).revision!,now:0);try require(equivalent(try visible(s),remote),"undo lost remote")
        _=try s.redo(revision:s.read(now:0).revision!,now:0);try require(equivalent(try visible(s)[2],remote[2]),"redo lost remote")
    }
    test("atomic-content-generated-host-result-foreign-released-and-cancelled-targets") {
        let (_,s)=try atomicSession(),(_,other)=try atomicSession();defer{try? s.dispose();try? other.dispose()}
        try s.setAtomicContentPolicy(images:true,references:true);try other.setAtomicContentPolicy(images:true,references:true)
        let before=try visible(s),foreignBefore=try visible(other)
        let captured=try atomicCommand(s,2,atomicReplacement(2))
        // A deterministic asynchronous host result owns this captured target, not
        // whichever editor currently has focus. Cancellation consumes its plan.
        let pending=try commandPlan(s,captured);try s.cancelCommands(token:pending.token)
        try expect({if case .InvalidPlan = $0{return true};return false}){_=try s.commitCommands(token:pending.token,now:0)}
        try expect({if case .InvalidAnchor = $0{return true};return false}){_=try commandPlan(other,captured)}
        var partial=captured;partial[0]["at"]=try commandAnchor(s,before[2]["id"] as! String,1)
        try expect({_ in true}){_=try commandPlan(s,partial)}
        try s.releaseAnchor(token:captured[0]["at"] as! String)
        try expect({if case .InvalidAnchor = $0{return true};return false}){_=try commandPlan(s,captured)}
        try require(equivalent(try visible(s),before) && equivalent(try visible(other),foreignBefore),"late/foreign result mutated")
    }

}
