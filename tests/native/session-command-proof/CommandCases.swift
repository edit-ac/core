import Foundation

// This is a consumer of the portable command DTO, not a native semantic dispatcher.
func commandJSON(_ commands: [[String: Any]]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: commands, options: [.sortedKeys]), as: UTF8.self)
}
func commandPlan(_ s: NativeSession, _ commands: [[String: Any]], now: UInt64 = 0) throws -> NativePreparedCommands {
    try s.prepareCommands(revision: s.read(now: now).revision!, commandsJson: commandJSON(commands), origin: "generated-command-proof", now: now)
}
@discardableResult
func commandApply(_ s: NativeSession, _ commands: [[String: Any]]) throws -> NativeSessionCommit {
    try s.commitCommands(token: commandPlan(s, commands).token, now: 0)!
}
func commandCreate(_ o: NativeSessionOptions) throws -> NativeSession {
    try NativeSession.createLocal(options: o, initial: [NativeSessionSeed(kind: "block", text: "A🦀אבB"), NativeSessionSeed(kind: "block", text: "second")])
}
func visible(_ s: NativeSession) throws -> [[String: Any]] {
    try wire(s.richSnapshot().snapshotJson)["visible"] as! [[String: Any]]
}
func nodeText(_ n: [String: Any]) -> String {
    (n["runs"] as! [[String: Any]]).map { $0["text"] as! String }.joined()
}
func commandAnchor(_ s: NativeSession, _ owner: String, _ offset: UInt32) throws -> String {
    try s.captureAnchors(revision: s.read(now: 0).revision!, inputs: [endpoint(owner, offset)])[0].token
}
func history(_ s: NativeSession, undo: UInt64, redo: UInt64, admitted: Bool = true, now: UInt64 = 0) throws {
    let h = try s.historyState(now: now)
    try require(h.undoGroups == undo && h.redoGroups == redo && h.canHistory == admitted && h.canUndo == (admitted && undo > 0) && h.canRedo == (admitted && redo > 0), "actual stack/admission mismatch: \(h)")
    try require(h.revision == s.read(now: now).revision && !h.recoveryRequired, "history revision/lifecycle mismatch")
}
func runCommandCases() {
    test("command-split-single-durable-commit-reopen-history") {
        let o = options(); let s = try commandCreate(o); defer { try? s.dispose() }
        try history(s, undo: 0, redo: 0)
        let before = try visible(s); let r = try s.read(now: 0); let owner = r.nodes[0].id
        let at = try commandAnchor(s, owner, 3)
        let commands: [[String: Any]] = [["type": "split", "owner": owner, "at": at]]
        try s.checkCommands(revision: r.revision!, commandsJson: commandJSON(commands), origin: "check", now: 0)
        let p = try commandPlan(s, commands)
        try require(p.revision == r.revision && equivalent(try visible(s), before), "prepare/check mutated")
        let c = try s.commitCommands(token: p.token, now: 0)!
        try require(c.sequence == 1 && c.checksum.count == 32 && c.durability == .processCrash, "durable command receipt")
        try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitCommands(token: p.token, now: 0) }
        let after = try visible(s)
        try require(after.count == 3 && nodeText(after[0]) == "A🦀" && nodeText(after[1]) == "אבB", "shared split UTF16/bidi")
        try history(s, undo: 1, redo: 0)
        _ = try s.undo(revision: s.historyState(now: 0).revision!, now: 0)
        try history(s, undo: 0, redo: 1)
        try require(equivalent(try visible(s), before), "split undo")
        _ = try s.redo(revision: s.historyState(now: 0).revision!, now: 0)
        try history(s, undo: 1, redo: 0)
        try s.dispose()
        let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
        try require(equivalent(try visible(reopened), after), "durable split redo restore")
        try history(reopened, undo: 0, redo: 0)
    }
    test("command-join-preserves-shared-unicode") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let r = try s.read(now: 0)
        try commandApply(s, [["type": "join", "first": r.nodes[0].id, "second": r.nodes[1].id]])
        let n = try visible(s)
        try require(n.count == 1 && nodeText(n[0]) == "A🦀אבBsecond", "join result")
        try history(s, undo: 1, redo: 0)
    }
    test("command-move-structural-versions-and-durable-order") {
        let o = options(); let s = try commandCreate(o); defer { try? s.dispose() }; let n = try visible(s)
        func target(_ node: [String: Any]) -> [String: Any] { ["id": node["id"]!, "version": (node["editor"] as! [String: Any])["version"]!] }
        try commandApply(s, [["type": "move", "target": target(n[1]), "parent": ["id": "@root", "version": "base"], "before": target(n[0])]])
        let after = try visible(s)
        try require(after.map { $0["id"] as! String } == n.reversed().map { $0["id"] as! String }, "move order")
        try s.dispose(); let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
        try require(equivalent(try visible(reopened), after), "move durable restore")
    }
    test("command-format-code-paragraph-and-list") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let owner = try s.read(now: 0).nodes[0].id
        try commandApply(s, [["type": "markAt", "owner": owner, "from": 1, "to": 5, "mark": "bold", "action": "apply"]])
        let marked = try visible(s)[0]["runs"] as! [[String: Any]]
        try require(marked.contains { $0["text"] as? String == "🦀אב" && ($0["attributes"] as? [String: Any])?["bold"] as? Bool == true }, "shared mark")
        try commandApply(s, [["type": "setCode", "owner": owner, "language": "rust"]])
        try require(equivalent(try visible(s)[0]["blockAttributes"]!, ["code", "rust"]), "code attributes")
        try commandApply(s, [["type": "setParagraph", "owner": owner]])
        try require(equivalent(try visible(s)[0]["blockAttributes"]!, ["paragraph"]), "paragraph attributes")
        try commandApply(s, [["type": "wrap", "targets": [owner], "style": ["type": "checklist"]]])
        try commandApply(s, [["type": "setChecked", "owner": owner, "checked": true]])
        let item = try visible(s).first { $0["id"] as? String == owner }!
        try require((item["editor"] as! [String: Any])["checked"] as? Bool == true, "checklist shared state")
        try commandApply(s, [["type": "setStyle", "container": item["parent"]!, "style": ["type": "ordered", "start": 3]]])
        try require((try visible(s).first { $0["id"] as? String == owner }!["editor"] as! [String: Any])["number"] as? Int == 3, "ordered list")
    }
    test("command-catalog-target-applicability-and-unavailable-profiles") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let catalog = try s.commandCatalog(now: 0)
        try require(catalog.revision == s.read(now: 0).revision && !catalog.schema.isEmpty && !catalog.profile.isEmpty, "catalog identity")
        for id in ["split", "join", "move", "markAt", "setCode", "wrap", "replaceAt"] {
            try require(catalog.routes.contains { $0.id == id && $0.available && $0.canPrepare && $0.reason == "target-check-required" }, "missing portable route \(id)")
        }
        try require(catalog.routes.contains { $0.id == "tableCell" && !$0.available && !$0.canPrepare }, "optional table route")
        try require(catalog.profiles.contains { $0.id == "editac.core" && $0.available }, "core profile")
        try require(catalog.profiles.filter { $0.id != "editac.core" }.allSatisfy { !$0.available && !$0.reason.isEmpty }, "optional service claims")
        let before = try s.read(now: 0)
        try expect({ if case .Engine = $0 { return true }; return false }) {
            try s.checkCommands(revision: before.revision!, commandsJson: commandJSON([["type": "join", "first": before.nodes[0].id, "second": "missing"]]), origin: "target", now: 0)
        }
        try require(try s.read(now: 0).revision == before.revision, "target rejection mutated")
        try history(s, undo: 0, redo: 0)
    }
    test("command-captured-anchor-follows-shared-edit") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let owner = try s.read(now: 0).nodes[0].id
        let at = try commandAnchor(s, owner, 3)
        try commandApply(s, [["type": "replaceAt", "owner": owner, "from": 0, "to": 0, "text": "前"]])
        try commandApply(s, [["type": "insert", "at": at, "text": "!"]])
        try require(try s.read(now: 0).nodes[0].text == "前A🦀!אבB", "captured target drift")
        try s.releaseAnchor(token: at)
    }
    test("command-history-new-edit-after-undo-and-readonly") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let owner = try s.read(now: 0).nodes[0].id
        try commandApply(s, [["type": "setCode", "owner": owner, "language": "rust"]]); try history(s, undo: 1, redo: 0)
        _ = try s.undo(revision: s.historyState(now: 0).revision!, now: 0); try history(s, undo: 0, redo: 1)
        try commandApply(s, [["type": "replaceAt", "owner": owner, "from": 0, "to": 0, "text": "new"]]); try history(s, undo: 1, redo: 0)
        try s.setPermission(writable: false, expiresAt: nil); try history(s, undo: 1, redo: 0, admitted: false)
        try require(!s.commandCatalog(now: 0).routes.contains { $0.canPrepare }, "readonly catalog")
        try require(try s.read(now: 0).nodes[0].text.hasPrefix("new") && !s.recoveryExport().checkpoint.bytes.isEmpty, "readonly readable/exportable")
        try expect({ if case .ReadOnly = $0 { return true }; return false }) { _ = try s.undo(revision: s.historyState(now: 0).revision!, now: 0) }
        try s.setPermission(writable: true, expiresAt: nil); try history(s, undo: 1, redo: 0)
    }
    test("command-permission-expiry-recheck-consumes-plan") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let owner = try s.read(now: 0).nodes[0].id
        let p = try commandPlan(s, [["type": "setCode", "owner": owner, "language": "rust"]])
        let r = try s.read(now: 0)
        try s.setPermission(writable: true, expiresAt: 5)
        try history(s, undo: 0, redo: 0, admitted: false, now: 5)
        try expect({ if case .PermissionExpired = $0 { return true }; return false }) { _ = try s.commitCommands(token: p.token, now: 5) }
        try s.setPermission(writable: true, expiresAt: nil)
        try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitCommands(token: p.token, now: 0) }
        try require(try s.read(now: 0).revision == r.revision, "expiry mutated")
    }
    test("command-invalid-input-utf16-resource-zero-mutation") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let r = try s.read(now: 0)
        let invalid = ["not-json", "[{\"type\":\"unknown\"}]", try commandJSON([["type": "replaceAt", "owner": r.nodes[0].id, "from": 2, "to": 3, "text": "split"]])]
        for json in invalid {
            do { _ = try s.prepareCommands(revision: r.revision!, commandsJson: json, origin: "invalid", now: 0); throw Failure(message: "invalid command accepted") }
            catch is NativeSessionError { }
        }
        try expect({ if case .ResourceLimit = $0 { return true }; return false }) {
            _ = try s.prepareCommands(revision: r.revision!, commandsJson: String(repeating: "x", count: 1_048_577), origin: "limit", now: 0)
        }
        try require(try s.read(now: 0).revision == r.revision && s.read(now: 0).pendingUpload == 0, "invalid command mutated")
        try history(s, undo: 0, redo: 0)
    }
    test("command-stale-cross-session-revision-and-token") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let other = try commandCreate(options()); defer { try? other.dispose() }
        let r = try s.read(now: 0); let commands: [[String: Any]] = [["type": "setCode", "owner": r.nodes[0].id, "language": "rust"]]
        let p = try commandPlan(s, commands)
        try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try other.commitCommands(token: p.token, now: 0) }
        try expect({ if case .Revision = $0 { return true }; return false }) {
            _ = try other.prepareCommands(revision: r.revision!, commandsJson: commandJSON(commands), origin: "foreign", now: 0)
        }
        try commandApply(s, [["type": "replaceAt", "owner": r.nodes[0].id, "from": 0, "to": 0, "text": "X"]])
        try expect({ if case .Revision(reason: .stale, message: _) = $0 { return true }; return false }) { _ = try s.commitCommands(token: p.token, now: 0) }
        try expect({ if case .Revision(reason: .stale, message: _) = $0 { return true }; return false }) { _ = try s.undo(revision: r.revision!, now: 0) }
        try expect({ if case .Revision = $0 { return true }; return false }) { _ = try other.redo(revision: r.revision!, now: 0) }
        try history(other, undo: 0, redo: 0)
    }
    test("command-plan-bounds-cancellation-alias-disposal") {
        let s = try commandCreate(options()); let alias = try FfiConverterTypeNativeSession.lift(s.uniffiCloneHandle()); defer { try? s.dispose() }
        let owner = try s.read(now: 0).nodes[0].id; let c: [[String: Any]] = [["type": "setCode", "owner": owner, "language": "rust"]]
        var plans: [String] = []
        for _ in 0..<128 { plans.append(try commandPlan(s, c).token) }
        try expect({ if case .ResourceLimit = $0 { return true }; return false }) { _ = try commandPlan(alias, c) }
        for p in plans { try alias.cancelCommands(token: p) }
        try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitCommands(token: plans[0], now: 0) }
        let p = try commandPlan(s, c); try history(alias, undo: 0, redo: 0)
        try alias.dispose(); try s.dispose()
        let ops: [() throws -> Void] = [
            { _ = try s.commandCatalog(now: 0) }, { _ = try alias.historyState(now: 0) },
            { _ = try s.commitCommands(token: p.token, now: 0) }, { try alias.cancelCommands(token: p.token) },
            { _ = try commandPlan(s, c) }, { try s.checkCommands(revision: p.revision, commandsJson: commandJSON(c), origin: "disposed", now: 0) }]
        for op in ops { try expect({ if case .Disposed = $0 { return true }; return false }, op) }
        try require(p.revision.count == 65 && !p.token.isEmpty, "detached plan lifetime")
    }
    test("command-concurrent-single-use-durable-disposal") {
        let o = options(); let s = try commandCreate(o); defer { try? s.dispose() }; let owner = try s.read(now: 0).nodes[0].id
        let p = try commandPlan(s, [["type": "replaceAt", "owner": owner, "from": 0, "to": 0, "text": "X"]]); let result = Results()
        race((0..<16).map { _ in { do { _ = try s.commitCommands(token: p.token, now: 0); result.add("commit") }
            catch NativeSessionError.InvalidPlan { result.add("consumed") } catch { result.add("unexpected: \(error)") } } })
        try require(result.outcomes.filter { $0 == "commit" }.count == 1 && result.outcomes.filter { $0 == "consumed" }.count == 15, "single command commit")
        try history(s, undo: 1, redo: 0)
        try s.dispose(); let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
        try require(try reopened.read(now: 0).nodes[0].text == "XA🦀אבB" && reopened.read(now: 0).pendingUpload == 1, "duplicate command/durable publication")
    }
    test("command-cancel-versus-commit-owner-order") {
        let s = try commandCreate(options()); defer { try? s.dispose() }; let owner = try s.read(now: 0).nodes[0].id
        let p = try commandPlan(s, [["type": "replaceAt", "owner": owner, "from": 0, "to": 0, "text": "X"]]); let result = Results()
        race([{ do { try s.cancelCommands(token: p.token); result.add("cancel") } catch { result.add("unexpected") } },
              { do { _ = try s.commitCommands(token: p.token, now: 0); result.add("commit") }
                catch NativeSessionError.InvalidPlan { result.add("canceled") } catch { result.add("unexpected") } }])
        let r = try s.read(now: 0)
        try require(result.outcomes.contains("cancel") && ((result.outcomes.contains("commit") && r.nodes[0].text == "XA🦀אבB" && r.pendingUpload == 1) || (result.outcomes.contains("canceled") && r.nodes[0].text == "A🦀אבB" && r.pendingUpload == 0)), "command cancel serialization")
    }
    test("command-dispose-versus-accepted-commit-owner-order") {
        let o = options(); let s = try commandCreate(o); defer { try? s.dispose() }; let owner = try s.read(now: 0).nodes[0].id
        let p = try commandPlan(s, [["type": "replaceAt", "owner": owner, "from": 0, "to": 0, "text": "X"]]); let result = Results()
        race([{ do { try s.dispose(); result.add("dispose") } catch { result.add("unexpected") } },
              { do { _ = try s.commitCommands(token: p.token, now: 0); result.add("commit") }
                catch NativeSessionError.Disposed { result.add("disposed") } catch { result.add("unexpected") } }])
        try require(result.outcomes.contains("dispose"), "command disposal")
        let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }; let r = try reopened.read(now: 0)
        try require((result.outcomes.contains("commit") && r.nodes[0].text == "XA🦀אבB" && r.pendingUpload == 1) || (result.outcomes.contains("disposed") && r.nodes[0].text == "A🦀אבB" && r.pendingUpload == 0), "command disposal did not await accepted commit")
    }
    test("command-sqlite-retained-update-history-catalog-recovery") {
        let o = options(); let s = try commandCreate(o); defer { try? s.dispose() }; let r = try s.read(now: 0)
        let p = try commandPlan(s, [["type": "replaceAt", "owner": r.nodes[0].id, "from": 0, "to": 0, "text": "recover"]])
        try sql(o.path, "CREATE TRIGGER ncb_fail BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'deterministic command append failure'); END;")
        defer { try? sql(o.path, "DROP TRIGGER IF EXISTS ncb_fail;") }
        try expect({ if case .Store = $0 { return true }; return false }) { _ = try s.commitCommands(token: p.token, now: 0) }
        let frozen = try s.read(now: 0); let h = try s.historyState(now: 0); let c = try s.commandCatalog(now: 0)
        try require(frozen.recoveryRequired && !frozen.locallyCommitted && frozen.revision == nil && frozen.nodes[0].text == "recoverA🦀אבB", "append failure save/recovery state")
        try require(h.recoveryRequired && h.revision == nil && h.undoGroups == 1 && h.redoGroups == 0 && !h.canHistory && !h.canUndo && !h.canRedo, "recovery history admission")
        try require(c.revision == nil && !c.routes.contains { $0.canPrepare }, "recovery command admission")
        let salvage = try s.recoveryExport()
        try require(!salvage.locallyCommitted && salvage.unjournaledUpdate != nil, "retained update export")
        try expect({ if case .RecoveryRequired = $0 { return true }; return false }) { _ = try s.undo(revision: r.revision!, now: 0) }
        try sql(o.path, "DROP TRIGGER ncb_fail;"); try s.recover(); try s.recover()
        try history(s, undo: 1, redo: 0)
        try require(try s.read(now: 0).pendingUpload == 1 && s.read(now: 0).locallyCommitted, "idempotent recovery duplicate")
        try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitCommands(token: p.token, now: 0) }
        try s.dispose(); let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
        try require(try reopened.read(now: 0).nodes[0].text == "recoverA🦀אבB" && reopened.read(now: 0).pendingUpload == 1, "durable recovery restore")
        try history(reopened, undo: 0, redo: 0)
    }

}
