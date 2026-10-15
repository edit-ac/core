import Foundation

func wire(_ value: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
}
func equivalent(_ a: Any, _ b: Any) -> Bool {
    NSDictionary(dictionary: ["value": a]).isEqual(to: ["value": b])
}
func richOptions(_ manifestPath: String) throws -> (NativeSessionOptions, [String: Any]) {
    let m = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: manifestPath))) as! [String: Any]
    next += 1
    let path = root.appendingPathComponent("rich-\(next).sqlite").path
    try FileManager.default.copyItem(atPath: m["path"] as! String, toPath: path)
    return (NativeSessionOptions(path: path, documentId: m["documentId"] as! String,
        epoch: m["epoch"] as! String, writable: true, permissionExpiresAt: nil), m)
}
func richEdit(_ s: NativeSession, _ node: String, _ from: UInt32, _ to: UInt32, _ value: String) throws -> String {
    try s.prepareEdits(revision: s.read(now: 0).revision!, edits: [NativeSessionEdit(node: node,
        fromUtf16: from, toUtf16: to, text: value)], origin: "generated-rich-session", now: 0)
}
func richCommit(_ s: NativeSession, _ node: String, _ from: UInt32, _ to: UInt32, _ value: String) throws {
    _ = try s.commitEdits(token: richEdit(s, node, from, to, value), now: 0)
}
func endpoint(_ node: String, _ offset: UInt32, _ bias: AnchorBias = .right) -> AnchorInput {
    AnchorInput(node: node, offsetUtf16: offset, bias: bias)
}
func capture(_ s: NativeSession, _ inputs: [AnchorInput]) throws -> [NativeSessionAnchor] {
    try s.captureAnchors(revision: s.read(now: 0).revision!, inputs: inputs)
}
func position(_ s: NativeSession, _ a: NativeSessionAnchor, _ node: String, _ offset: UInt32, _ bias: AnchorBias = .right) throws {
    let r = try s.resolveAnchor(token: a.token)
    try require(r.documentId == a.documentId && r.epoch == a.epoch && r.revision == s.read(now: 0).revision, "resolved lineage/revision")
    guard case let .position(n, o, source, _, b) = r.resolution else { throw Failure(message: "expected shared position: \(r)") }
    try require(n == node && o == offset && b == bias && !source.isEmpty, "shared position expected \(node):\(offset):\(bias), got \(r.resolution)")
}
func sql(_ path: String, _ statement: String) throws {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
    p.arguments = [path, statement]
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
    try p.run(); p.waitUntilExit()
    try require(p.terminationStatus == 0, "fixture SQL failed: \(String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))")
}
func runRichCases(_ manifestPath: String) {
    func fixture() throws -> (NativeSession, NativeSessionOptions, [String: Any]) {
        let (o, m) = try richOptions(manifestPath); return (try NativeSession.open(options: o), o, m)
    }
    test("rich-actual-checkpoint-snapshot-identity-marks-attachment") {
        let (s, _, m) = try fixture(); defer { try? s.dispose() }
        let r = try s.richSnapshot(); let w = try wire(r.snapshotJson)
        let expected = m["expected"] as! [String: Any]
        for key in ["visible", "identity", "retainedStructure"] {
            try require(equivalent(w[key]!, expected[key]!), "shared fixture mismatch: \(key)")
        }
        let nodes = w["visible"] as! [[String: Any]]
        try require(nodes.count == 3 && r.revision == s.read(now: 0).revision, "rich node count/revision")
        let runs = nodes[0]["runs"] as! [[String: Any]]
        try require(runs[0]["text"] as? String == "A🦀אב" && !(runs[0]["attributes"] as! [String: Any]).isEmpty, "marks/bidi/Unicode")
        try require(nodes[1]["blockAttributes"] != nil && (nodes[1]["spans"] as! [[String: Any]])[0]["identity"] is String, "attachment identity")
    }
    test("rich-ordered-incremental-range-identity-and-alias-cursor") {
        let (s, _, _) = try fixture(); defer { try? s.dispose() }; let alias = s
        let before = try s.richSnapshot(); let original = try wire(before.snapshotJson)
        let nodes = original["visible"] as! [[String: Any]]; let node = nodes[0]["id"] as! String
        try richCommit(s, node, 1, 3, "😀"); try richCommit(s, node, 0, 0, "X")
        _ = try alias.read(now: 0)
        let delta = try alias.takeRichPatches(afterSequence: before.sequence)
        try require(delta.patchesJson.count == 2 && delta.sequence == before.sequence + 2 && delta.afterSequence == before.sequence, "ordered cursor")
        for (i, json) in delta.patchesJson.enumerated() {
            let p = try wire(json)
            try require((p["sequence"] as! NSNumber).uint64Value == before.sequence + UInt64(i) + 1 && equivalent(p["identity"]!, original["identity"]!), "patch sequence/identity")
            try require(p["changedNodes"] as! [String] == [node] && (p["nodes"] as! [Any]).count == 1, "incremental changed node")
        }
        let range = (try wire(delta.patchesJson[0])["touchedRanges"] as! [[String: Any]])[0]
        try require(range["start"] as? Int == 1 && range["oldEnd"] as? Int == 3 && range["newEnd"] as? Int == 3, "UTF16 range")
        let after = try wire(s.richSnapshot().snapshotJson)["visible"] as! [[String: Any]]
        try require(equivalent(nodes[1], after[1]) && equivalent(nodes[2], after[2]), "unchanged rich node identity")
        try require(equivalent((nodes[0]["spans"] as! [[String: Any]])[0]["identity"]!, (after[0]["spans"] as! [[String: Any]])[0]["identity"]!), "stable run identity")
        try require(delta.revision == s.read(now: 0).revision, "patch revision")
    }
    test("rich-atomic-invalid-edits-cursor-and-cancellation") {
        let (s, _, _) = try fixture(); defer { try? s.dispose() }
        try expect({ if case .ProjectionResyncRequired = $0 { return true }; return false }) { _ = try s.takeRichPatches(afterSequence: 0) }
        let before = try s.richSnapshot(); let read = try s.read(now: 0); let node = read.nodes[0].id
        let checkpoint = try s.recoveryExport().checkpoint.bytes
        try expect({ if case .Engine = $0 { return true }; return false }) {
            _ = try s.prepareEdits(revision: before.revision, edits: [NativeSessionEdit(node: node, fromUtf16: 2, toUtf16: 3, text: "split-surrogate")], origin: "unicode-boundary", now: 0)
        }
        try expect({ if case .Engine = $0 { return true }; return false }) {
            _ = try s.prepareEdits(revision: before.revision, edits: [NativeSessionEdit(node: node, fromUtf16: 0, toUtf16: 0, text: "valid"), NativeSessionEdit(node: node, fromUtf16: 100, toUtf16: 100, text: "invalid")], origin: "atomic", now: 0)
        }
        let plan = try richEdit(s, node, 0, 0, "cancelled"); try s.cancelEdits(token: plan)
        try expect({ if case .InvalidPlan = $0 { return true }; return false }) { _ = try s.commitEdits(token: plan, now: 0) }
        try require(try s.recoveryExport().checkpoint.bytes == checkpoint && s.read(now: 0).revision == before.revision, "failed/canceled mutation")
        try richCommit(s, node, 0, 0, "valid")
        try expect({ if case .InvalidProjectionCursor = $0 { return true }; return false }) { _ = try s.takeRichPatches(afterSequence: before.sequence + 100) }
        try require(try s.takeRichPatches(afterSequence: before.sequence).patchesJson.count == 1, "failed cursor drained")
    }
    test("rich-patch-count-and-byte-bounds-resync") {
        for byteLimit in [false, true] {
            let (s, _, _) = try fixture(); defer { try? s.dispose() }
            let before = try s.richSnapshot(); let node = try s.read(now: 0).nodes[0].id
            let count = byteLimit ? 12 : 129; let value = byteLimit ? String(repeating: "x", count: 20000) : "x"
            for _ in 0..<count { try richCommit(s, node, 0, 0, value) }
            try expect({ if case .ProjectionResyncRequired = $0 { return true }; return false }) { _ = try s.takeRichPatches(afterSequence: before.sequence) }
            let after = try s.richSnapshot()
            try require(after.sequence == before.sequence + UInt64(count) && s.read(now: 0).nodes[0].text.hasPrefix(String(repeating: value, count: count)), "resync lost commits")
            try require(try s.takeRichPatches(afterSequence: after.sequence).patchesJson.isEmpty, "resync cursor")
        }
    }
    test("rich-anchor-selected-node-movement-bias-and-deleted-text-history") {
        let (s, o, _) = try fixture(); defer { try? s.dispose() }; let nodes = try s.read(now: 0).nodes
        let a = try capture(s, [endpoint(nodes[0].id, 3, .left), endpoint(nodes[0].id, 3), endpoint(nodes[2].id, 8)])
        for anchor in a { try require(anchor.documentId == o.documentId && anchor.epoch == o.epoch && anchor.revision == s.read(now: 0).revision, "capture lineage") }
        try richCommit(s, nodes[0].id, 3, 3, "😀"); try richCommit(s, nodes[2].id, 0, 0, "אב")
        try position(s, a[0], nodes[0].id, 3, .left); try position(s, a[1], nodes[0].id, 5); try position(s, a[2], nodes[2].id, 10)
        let (deletion, _, _) = try fixture(); defer { try? deletion.dispose() }
        let target = try deletion.read(now: 0).nodes[0].id
        let retained = try capture(deletion, [endpoint(target, 3)])[0]
        try richCommit(deletion, target, 1, 5, "")
        try position(deletion, retained, target, 1)
        _ = try deletion.undo(revision: deletion.read(now: 0).revision!, now: 0); try position(deletion, retained, target, 1)
        _ = try deletion.redo(revision: deletion.read(now: 0).revision!, now: 0); try position(deletion, retained, target, 1)
    }
    test("rich-anchor-unicode-bidi-combining-atom-boundaries") {
        let (s, _, _) = try fixture(); defer { try? s.dispose() }; let nodes = try s.read(now: 0).nodes
        for (index, offsets) in [(0, [0, 1, 3, 4, 5]), (1, [0]), (2, [0, 5, 6, 7, 8, 9, 10, 11, 12])] {
            for offset in offsets { for bias in [AnchorBias.left, .right] {
                let a = try capture(s, [endpoint(nodes[index].id, UInt32(offset), bias)])[0]
                try position(s, a, nodes[index].id, UInt32(offset), bias); try s.releaseAnchor(token: a.token)
            } }
        }
        for (index, offset) in [(0, 2), (0, 6), (1, 1)] {
            try expect({ if case .AnchorTarget = $0 { return true }; return false }) { _ = try capture(s, [endpoint(nodes[index].id, UInt32(offset))]) }
        }
    }
    test("rich-anchor-atomic-stale-cross-document-and-malformed-rejection") {
        let (s, _, _) = try fixture(); defer { try? s.dispose() }; let r = try s.read(now: 0); let input = endpoint(r.nodes[0].id, 1)
        let other = try create(options()); defer { try? other.dispose() }
        try expect({ if case .Revision(reason: .scopeMismatch, message: _) = $0 { return true }; return false }) { _ = try s.captureAnchors(revision: other.read(now: 0).revision!, inputs: [input]) }
        try expect({ if case .Revision(reason: .invalidToken, message: _) = $0 { return true }; return false }) { _ = try s.captureAnchors(revision: Data(repeating: 0, count: 65), inputs: [input]) }
        try richCommit(s, r.nodes[0].id, 1, 3, "")
        try expect({ if case .Revision(reason: .stale, message: _) = $0 { return true }; return false }) { _ = try s.captureAnchors(revision: r.revision!, inputs: [input]) }
        let before = try s.recoveryExport().checkpoint.bytes
        try expect({ if case .AnchorTarget = $0 { return true }; return false }) { _ = try capture(s, [input, endpoint("missing", 0)]) }
        try require(try s.recoveryExport().checkpoint.bytes == before, "capture mutated document")
        var held: [NativeSessionAnchor] = []
        for _ in 0..<8 { held += try capture(s, Array(repeating: input, count: 128)) }
        try require(held.count == 1024, "invalid batch leaked slots")
    }
    test("rich-anchor-bounds-release-no-token-reuse") {
        let (s, _, _) = try fixture(); defer { try? s.dispose() }; let input = endpoint(try s.read(now: 0).nodes[0].id, 1)
        try expect({ if case .ResourceLimit = $0 { return true }; return false }) { _ = try capture(s, Array(repeating: input, count: 129)) }
        var held: [NativeSessionAnchor] = []
        for _ in 0..<8 { held += try capture(s, Array(repeating: input, count: 128)) }
        try expect({ if case .ResourceLimit = $0 { return true }; return false }) { _ = try capture(s, [input]) }
        let old = held[0]; try s.releaseAnchor(token: old.token); try s.releaseAnchor(token: old.token)
        try expect({ if case .InvalidAnchor = $0 { return true }; return false }) { _ = try s.resolveAnchor(token: old.token) }
        let fresh = try capture(s, [input])[0]; try require(fresh.token != old.token, "token reuse")
        for a in held { try s.releaseAnchor(token: a.token) }; try s.releaseAnchor(token: fresh.token)
    }
    test("rich-owned-values-cross-worker-disposal-and-reopen") {
        let (s, o, _) = try fixture(); let other = try NativeSession.open(options: o); defer { try? other.dispose() }
        let before = try s.richSnapshot(); let node = try s.read(now: 0).nodes[0].id
        let a = try capture(s, [endpoint(node, 3)])[0]; let b = try capture(other, [endpoint(node, 3)])[0]
        try require(a.token != b.token, "cross-worker namespace")
        try expect({ if case .InvalidAnchor = $0 { return true }; return false }) { _ = try other.resolveAnchor(token: a.token) }
        try other.releaseAnchor(token: a.token); try position(s, a, node, 3)
        let detached = try s.resolveAnchor(token: a.token)
        try richCommit(s, node, 0, 0, "X"); let patches = try s.takeRichPatches(afterSequence: before.sequence)
        let alias = s; try alias.dispose(); try s.dispose()
        let ops: [() throws -> Void] = [{ _ = try s.richSnapshot() }, { _ = try alias.takeRichPatches(afterSequence: patches.sequence) }, { _ = try alias.captureAnchors(revision: before.revision, inputs: []) }, { _ = try s.resolveAnchor(token: a.token) }, { try s.releaseAnchor(token: a.token) }]
        for op in ops { try expect({ if case .Disposed = $0 { return true }; return false }, op) }
        try require(!before.snapshotJson.isEmpty && patches.patchesJson.count == 1 && detached.documentId == o.documentId && !a.revision.isEmpty, "owned conversion after disposal")
        try position(other, b, node, 3); try other.dispose()
        let reopened = try NativeSession.open(options: o); defer { try? reopened.dispose() }
        try expect({ if case .InvalidAnchor = $0 { return true }; return false }) { _ = try reopened.resolveAnchor(token: a.token) }
        try require(try reopened.read(now: 0).nodes[0].text == "XA🦀אב", "reopen rich state")
    }
    test("rich-anchor-deleted-owner-through-durable-shared-session-replay") {
        let (s, o, _) = try fixture(); defer { try? s.dispose() }
        let before = try s.richSnapshot(); let node = try s.read(now: 0).nodes[1].id
        let a = try capture(s, [endpoint(node, 0)])[0]
        guard let index = CommandLine.arguments.firstIndex(of: "--fixture-writer") else { throw Failure(message: "missing actual shared Session fixture writer") }
        let p = Process(); p.executableURL = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        p.arguments = ["--disable", o.path, o.documentId, o.epoch, node]
        let output = Pipe(); p.standardOutput = output; p.standardError = output
        try p.run(); p.waitUntilExit()
        try require(p.terminationStatus == 0, "actual remote shared Session command failed: \(String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))")
        // Replay the real durable update into this same native worker/owner.
        try s.recover()
        let resolved = try s.resolveAnchor(token: a.token)
        guard case let .deleted(source, owner) = resolved.resolution else { throw Failure(message: "missing shared deleted-owner result: \(resolved)") }
        try require(owner == node && !source.isEmpty && resolved.documentId == o.documentId && resolved.epoch == o.epoch && resolved.revision != before.revision, "deleted owner lineage")
        try expect({ if case .AnchorTarget = $0 { return true }; return false }) { _ = try capture(s, [endpoint(node, 0)]) }
        let after = try s.richSnapshot(); let visible = try wire(after.snapshotJson)["visible"] as! [[String: Any]]
        try require(visible.count == 2 && !visible.contains { $0["id"] as? String == node }, "rich deleted owner replay")
        try s.releaseAnchor(token: a.token)
    }
    test("rich-real-sqlite-failure-freeze-salvage-recovery-and-anchor-cleanup") {
        let (s, o, _) = try fixture(); defer { try? s.dispose() }; let before = try s.richSnapshot(); let node = try s.read(now: 0).nodes[0].id
        let a = try capture(s, [endpoint(node, 3), endpoint(node, 3)])
        let plan = try richEdit(s, node, 0, 0, "recover")
        try sql(o.path, "CREATE TRIGGER rpr_fail BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'deterministic fixture failure'); END;")
        defer { try? sql(o.path, "DROP TRIGGER IF EXISTS rpr_fail;") }
        try expect({ if case .Store = $0 { return true }; return false }) { _ = try s.commitEdits(token: plan, now: 0) }
        try require(try s.read(now: 0).recoveryRequired && !s.read(now: 0).locallyCommitted, "failure did not freeze")
        let ops: [() throws -> Void] = [{ _ = try s.richSnapshot() }, { _ = try s.takeRichPatches(afterSequence: before.sequence) }, { _ = try s.captureAnchors(revision: before.revision, inputs: []) }, { _ = try s.resolveAnchor(token: a[0].token) }]
        for op in ops { try expect({ if case .RecoveryRequired = $0 { return true }; return false }, op) }
        try s.releaseAnchor(token: a[0].token)
        let salvage = try s.recoveryExport(); try require(!salvage.locallyCommitted && salvage.unjournaledUpdate != nil, "salvage ownership")
        try sql(o.path, "DROP TRIGGER rpr_fail;"); try s.recover()
        try require(try !s.read(now: 0).recoveryRequired && s.read(now: 0).locallyCommitted, "recovery did not commit")
        try position(s, a[1], node, 10)
        try expect({ if case .InvalidAnchor = $0 { return true }; return false }) { _ = try s.resolveAnchor(token: a[0].token) }
        let restored = try s.richSnapshot(); try require(try s.read(now: 0).nodes[0].text == "recoverA🦀אב" && s.takeRichPatches(afterSequence: restored.sequence).patchesJson.isEmpty, "recovery resync")
    }
}
