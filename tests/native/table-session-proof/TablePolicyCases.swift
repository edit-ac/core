import Foundation

// Only baseline preparation uses the existing native table corpus factory.
// Every qualifying edit below executes generated NativeSession methods.
func tableSession() throws -> (NativeSessionOptions, NativeSession) {
    let index = CommandLine.arguments.firstIndex(of: "--table-fixture")!
    let manifest = try wire(String(contentsOfFile: CommandLine.arguments[index + 1], encoding: .utf8))
    let path = options().path
    try FileManager.default.copyItem(atPath: manifest["path"] as! String, toPath: path)
    let o = NativeSessionOptions(path: path, documentId: manifest["documentId"] as! String,
        epoch: manifest["epoch"] as! String, writable: true, permissionExpiresAt: nil)
    return (o, try NativeSession.open(options: o))
}
func tableCommand(_ s: NativeSession, _ text: String) throws -> [[String: Any]] {
    let table = try visible(s)[1]
    return [["type": "tableCell", "owner": table["id"]!, "expected": table["blockAttributes"]!,
        "row": 0, "column": 0, "text": text]]
}
func tableCatalog(_ s: NativeSession, available: Bool, admitted: Bool = true, now: UInt64 = 0) throws {
    let c = try s.commandCatalog(now: now)
    try require(c.routes.contains { $0.id == "tableCell" && $0.available == available && $0.canPrepare == (available && admitted) }, "table route policy/admission")
    try require(c.profiles.contains { $0.id == "editac.tables" && $0.available == available }, "table profile policy")
}
func runTablePolicyCases() {
    test("table-structure-generated-v1-all-actions-history-reopen") {
        let (o,s)=try tableSession(); defer {try? s.dispose()}
        try s.setTablePolicy(enabled:true)
        let before=try visible(s)
        for action in ["insertRow","insertColumn","deleteRow","deleteColumn"] {
            let table=try visible(s)[1]
            let c:[[String:Any]]=[["type":"tableStructure","owner":table["id"]!,"expected":table["blockAttributes"]!,"action":action,"index":1]]
            let p=try commandPlan(s,c)
            try require(equivalent(try visible(s)[1],table),"structure prepare mutated")
            _=try s.commitCommands(token:p.token,now:0)!
        }
        let after=try visible(s)
        try require(equivalent(after[1]["blockAttributes"]!,before[1]["blockAttributes"]!) && equivalent(after[1]["id"]!,before[1]["id"]!) && equivalent(after[2],before[2]),"insert/delete did not retain exact rich payload")
        try history(s,undo:4,redo:0)
        for _ in 0..<4 {_=try s.undo(revision:s.read(now:0).revision!,now:0)}
        try require(equivalent(try visible(s),before),"structure undo")
        for _ in 0..<4 {_=try s.redo(revision:s.read(now:0).revision!,now:0)}
        try require(equivalent(try visible(s),after),"structure redo")
        try s.dispose();let reopened=try NativeSession.open(options:o);defer{try? reopened.dispose()}
        try require(equivalent(try visible(reopened),after),"structure durable reopen")
    }
    test("table-v2-generated-cell-retains-span-and-rejects-geometry") {
        let (_,s)=try tableSession();defer{try? s.dispose()};try s.setTablePolicy(enabled:true)
        let before=try visible(s),t=before[2]
        let c:[[String:Any]]=[["type":"tableCell","owner":t["id"]!,"expected":t["blockAttributes"]!,"row":0,"column":0,"text":"rich X😀"]]
        _=try commandApply(s,c)
        let after=try visible(s)
        try require(!equivalent(after[2],t) && equivalent(after[1],before[1]),"v2 real edit/unaffected table")
        do {
            _=try commandPlan(s,[["type":"tableStructure","owner":t["id"]!,"expected":after[2]["blockAttributes"]!,"action":"insertRow","index":0]])
            throw NSError(domain:"table-proof-unexpected-success",code:1)
        } catch let error as NativeSessionError {
            // The shared planner's unsupported geometry diagnostic is transported
            // in the existing command error; no new ABI error tag is required.
            try require(String(describing:error).contains("UnsupportedTarget"),"precise span rejection")
        }
        try require(equivalent(try visible(s),after),"rejected span structure mutated")
        _=try s.undo(revision:s.read(now:0).revision!,now:0)
        try require(equivalent(try visible(s),before),"v2 undo")
        _=try s.redo(revision:s.read(now:0).revision!,now:0)
        try require(equivalent(try visible(s),after),"v2 redo")
    }
    test("table-policy-real-cell-cancel-history-reopen") {
        let (o, s) = try tableSession(); defer { try? s.dispose() }
        let before = try visible(s); let revision = try s.read(now: 0).revision!
        let commands = try tableCommand(s, "Header 🦀אב!")
        try tableCatalog(s, available: false)
        try expect({ if case .UnsupportedModule = $0 { return true }; return false }) { _ = try commandPlan(s, commands) }
        try s.setTablePolicy(enabled: true); try tableCatalog(s, available: true)
        try s.checkCommands(revision: revision, commandsJson: commandJSON(commands), origin: "table", now: 0)
        let cancelled = try commandPlan(s, commands)
        try s.cancelCommands(token: cancelled.token); try s.cancelCommands(token: cancelled.token)
        try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitCommands(token: cancelled.token, now: 0) }
        try require(equivalent(try visible(s), before) && s.read(now: 0).revision == revision, "prepare/cancel mutated")
        let receipt = try commandApply(s, commands)
        try require(receipt.sequence == 1 && receipt.checksum.count == 32, "actual table durability")
        let after = try visible(s)
        try require(!equivalent(after, before) && equivalent(after[2], before[2]) && equivalent(after[1]["id"]!, before[1]["id"]!), "table identity/unaffected rich payload")
        try history(s, undo: 1, redo: 0)
        _ = try s.undo(revision: s.read(now: 0).revision!, now: 0)
        try require(equivalent(try visible(s), before), "cell undo")
        _ = try s.redo(revision: s.read(now: 0).revision!, now: 0)
        try require(equivalent(try visible(s), after), "cell redo")
        try s.dispose()
        let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
        try require(equivalent(try visible(reopened), after), "table SQLite reopen")
        try tableCatalog(reopened, available: false)
        try commandApply(reopened, [["type": "replaceAt", "owner": after[0]["id"]!, "from": 0, "to": 6, "text": "paragraph"]])
        try require(nodeText(try visible(reopened)[0]) == "paragraph", "unchanged paragraph command")
        try reopened.dispose()
        try expect({ if case .Disposed = $0 { return true }; return false }) { try reopened.setTablePolicy(enabled: true) }
    }
    test("table-policy-revocation-permission-expiry-zero-mutation") {
        let (_, s) = try tableSession(); defer { try? s.dispose() }
        let before = try visible(s); let revision = try s.read(now: 0).revision!
        try s.setTablePolicy(enabled: true)
        let commands = try tableCommand(s, "denied")
        let p = try commandPlan(s, commands)
        try s.setTablePolicy(enabled: false)
        try expect({ if case .UnsupportedModule = $0 { return true }; return false }) { _ = try s.commitCommands(token: p.token, now: 0) }
        try s.setPermission(writable: false, expiresAt: nil); try s.setTablePolicy(enabled: true)
        try tableCatalog(s, available: true, admitted: false)
        try expect({ if case .ReadOnly = $0 { return true }; return false }) { _ = try commandPlan(s, commands) }
        try s.setPermission(writable: true, expiresAt: 10)
        let expiring = try commandPlan(s, commands)
        try expect({ if case .PermissionExpired = $0 { return true }; return false }) { _ = try s.commitCommands(token: expiring.token, now: 10) }
        try require(equivalent(try visible(s), before) && s.read(now: 0).revision == revision, "policy/permission rejection mutated")
        try require(try s.read(now: 0).pendingUpload == 0, "denied table journal append")
    }
    test("table-policy-invalid-target-and-stale-tuple") {
        let (_, s) = try tableSession(); defer { try? s.dispose() }; try s.setTablePolicy(enabled: true)
        let before = try visible(s); let revision = try s.read(now: 0).revision!
        let original = try tableCommand(s, "stale")
        for (key, value) in [("row", 128 as Any), ("column", 32 as Any), ("text", "line\nbreak" as Any), ("owner", before[0]["id"]!)] {
            var bad = original; bad[0][key] = value
            try expect({ if case .Engine = $0 { return true }; return false }) { _ = try commandPlan(s, bad) }
            try require(equivalent(try visible(s), before) && s.read(now: 0).revision == revision, "invalid table mutated")
        }
        let captured = try commandPlan(s, original)
        try commandApply(s, try tableCommand(s, "current"))
        let after = try visible(s)
        try expect({ if case .Revision = $0 { return true }; return false }) { _ = try s.commitCommands(token: captured.token, now: 0) }
        try expect({ if case .Engine = $0 { return true }; return false }) { _ = try commandPlan(s, original) }
        try require(equivalent(try visible(s), after), "stale table mutated")
    }
}
