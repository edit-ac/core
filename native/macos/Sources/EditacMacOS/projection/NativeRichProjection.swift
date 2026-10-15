import AppKit

/// Owned wire data is retained without creating a second semantic model.
struct RichProjectionNode {
    let wire: [String: Any]
    let id: String
    let kind: String
    let order: Int
    let runs: [[String: Any]]
    let attachment: Bool
    let text: String

    init(_ wire: [String: Any]) throws {
        guard let id = wire["id"] as? String, !id.isEmpty, let order = wire["order"] as? Int, order >= 0,
              let kind = wire["kind"] as? String, ["block", "list", "quote"].contains(kind),
              let runs = wire["runs"] as? [[String: Any]],
              runs.allSatisfy({ $0["text"] is String && $0["attributes"] is [String: Any] }) else {
            throw NativeProjectionFailure.malformedRichProjection
        }
        self.wire = wire; self.id = id; self.kind = kind; self.order = order; self.runs = runs
        let tuple = wire["blockAttributes"] as? [Any]
        attachment = (tuple?.first as? String)?.hasPrefix("module:") == true
        text = attachment ? "\u{FFFC}" : runs.map { $0["text"] as! String }.joined()
    }
}

extension NativeTextProjection {
    public static let sharedRunAttributes = NSAttributedString.Key("ac.shared.run")
    public static let sharedNodeAttributes = NSAttributedString.Key("ac.shared.node")

    private func object(_ json: String) throws -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeProjectionFailure.malformedRichProjection
        }
        return object
    }

    private func identity(_ object: [String: Any]) throws -> Data {
        guard let value = object["identity"] as? [String: Any] else {
            throw NativeProjectionFailure.malformedRichProjection
        }
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    /// Validate the entire batch before touching the control or its identity map.
    public func apply(_ update: NativeProjectionUpdate) throws {
        guard !disposed else { throw NativeProjectionFailure.disposed }
        var next = richNodes
        var sequence = richSequence
        var lineage = richIdentity
        let revision: Data
        if let snapshot = update.snapshot {
            guard update.patches == nil else { throw NativeProjectionFailure.invalidCursor }
            let value = try object(snapshot.snapshotJson)
            let newIdentity = try identity(value)
            if let lineage, lineage != newIdentity { throw NativeProjectionFailure.staleTarget }
            lineage = newIdentity
            guard let visible = value["visible"] as? [[String: Any]] else {
                throw NativeProjectionFailure.malformedRichProjection
            }
            next = [:]
            for value in visible {
                let node = try RichProjectionNode(value)
                guard next.updateValue(node, forKey: node.id) == nil else {
                    throw NativeProjectionFailure.duplicateIdentity
                }
            }
            sequence = snapshot.sequence; revision = snapshot.revision
        } else if let patches = update.patches {
            guard patches.afterSequence == sequence else { throw NativeProjectionFailure.invalidCursor }
            var cursor = patches.afterSequence
            for json in patches.patchesJson {
                let value = try object(json)
                guard cursor < UInt64.max, value["version"] as? Int == 1,
                      (value["sequence"] as? NSNumber)?.uint64Value == cursor + 1,
                      try identity(value) == lineage,
                      value["projectionError"] is NSNull,
                      let changes = value["nodes"] as? [[String: Any]] else {
                    throw NativeProjectionFailure.invalidCursor
                }
                for change in changes {
                    switch change["type"] as? String {
                    case "visible":
                        guard let wire = change["node"] as? [String: Any] else {
                            throw NativeProjectionFailure.malformedRichProjection
                        }
                        let node = try RichProjectionNode(wire); next[node.id] = node
                    case "removed", "recovery":
                        guard let id = change["id"] as? String ?? (change["node"] as? [String: Any])?["id"] as? String else {
                            throw NativeProjectionFailure.malformedRichProjection
                        }
                        next.removeValue(forKey: id)
                    default: throw NativeProjectionFailure.malformedRichProjection
                    }
                }
                cursor += 1
            }
            guard cursor == patches.sequence else { throw NativeProjectionFailure.invalidCursor }
            sequence = cursor; revision = patches.revision
        } else { throw NativeProjectionFailure.malformedRichProjection }
        // Containers are retained shared structure, not editable text rows.
        // Their child block IDs/ranges remain stable through list/quote commands;
        // attributed paragraph/list presentation belongs to the styles owner.
        let ordered = next.values.filter { $0.kind == "block" }.sorted { $0.order == $1.order ? $0.id < $1.id : $0.order < $1.order }
        // Text-only mapper remains the coordinate implementation, with one native
        // attachment unit per shared atom. It never edits the shared document.
        let snapshot = NativeSessionRead(revision: revision,
            nodes: ordered.map { NativeSessionNode(id: $0.id, kind: "block", text: $0.text) },
            recoveryRequired: false, pendingUpload: 0, locallyCommitted: true,
            localDurability: .unknown, canApply: false, canHistory: false, recoveryError: nil)
        let prior = selectedTarget
        let savedAnchored = anchoredSelection && prior.flatMap { try? range(for: $0) } == textView.selectedRange()
        // A native caret change supersedes the previously captured async target.
        // Never reactivate its old anchors on a later unchanged read.
        anchoredSelection = savedAnchored
        selectionResolutions = update.selection
        let oldRanges = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.range) })
        let oldStorage = Dictionary(uniqueKeysWithValues: nodes.map {
            ($0.id, textView.textStorage!.attributedSubstring(from: $0.range))
        })
        try apply(snapshot)
        let storage = textView.textStorage!
        storage.beginEditing()
        var attachments: [String: NSTextAttachment] = [:]
        for node in ordered {
            let range = nodes.first { $0.id == node.id }!.range
            // Do not rewrite attributes of unchanged runs/nodes.
            let changed = richNodes[node.id].map {
                !NSDictionary(dictionary: $0.wire).isEqual(to: node.wire)
            } ?? true
            if !changed, let old = oldStorage[node.id], old.length == range.length,
               let patch = lastPatch, let oldRange = oldRanges[node.id],
               NSIntersectionRange(patch.range, oldRange).length > 0 {
                old.enumerateAttributes(in: NSRange(location: 0, length: old.length)) { attributes, local, _ in
                    storage.setAttributes(attributes, range: NSRange(location: range.location + local.location, length: local.length))
                }
            }
            if changed && range.length > 0 {
                storage.removeAttribute(.attachment, range: range)
                storage.removeAttribute(Self.sharedRunAttributes, range: range)
            }
            if node.attachment {
                let attachment = attachmentIdentities[node.id] ?? NSTextAttachment()
                attachments[node.id] = attachment
                if changed || storage.attribute(.attachment, at: range.location, effectiveRange: nil) == nil {
                    storage.addAttribute(.attachment, value: attachment, range: range)
                }
            }
            if changed && range.length > 0 {
                storage.addAttribute(Self.sharedNodeAttributes, value: node.wire as NSDictionary, range: range)
                if !node.attachment {
                    var offset = range.location
                    for run in node.runs {
                        let text = run["text"] as! String
                        let runRange = NSRange(location: offset, length: text.utf16.count)
                        storage.addAttribute(Self.sharedRunAttributes, value: run["attributes"] as! NSDictionary, range: runRange)
                        offset += runRange.length
                    }
                }
            }
        }
        storage.endEditing()
        richNodes = next; richSequence = sequence; richIdentity = lineage
        attachmentIdentities = attachments
        if savedAnchored, let prior {
            guard update.selection.count == 2,
                  update.selection.allSatisfy({ read in
                      guard let lineage,
                            let wire = try? JSONSerialization.jsonObject(with: lineage) as? [String: Any] else { return false }
                      return read.revision == revision && read.documentId == wire["documentId"] as? String && read.epoch == wire["epoch"] as? String
                  }) else {
                invalidateAnchoredSelection(); return
            }
            func endpoint(_ read: NativeSessionAnchorRead) -> NativeTextEndpoint? {
                guard case let .position(node, offset, _, _, bias) = read.resolution,
                      let projected = nodes.first(where: { $0.id == node }) else { return nil }
                // Shared atoms have zero semantic text width and one native unit.
                let nativeOffset = richNodes[node]?.attachment == true ? (bias == .right ? 1 : 0) : Int(offset)
                guard Self.isBoundary(nativeOffset, in: projected.text) else { return nil }
                return NativeTextEndpoint(node: node, offsetUTF16: nativeOffset)
            }
            if let anchor = endpoint(update.selection[0]), let focus = endpoint(update.selection[1]) {
                let target = NativeTextSelectionTarget(owner: owner, revision: revision,
                    anchor: anchor, focus: focus, affinity: prior.affinity)
                try select(target); anchoredSelection = true; selectionInvalidated = false
            } else { invalidateAnchoredSelection() }
        }
    }

    func invalidateAnchoredSelection() {
        anchoredSelection = false; selectedTarget = nil; selectionInvalidated = true
        textView.setSelectedRange(NSRange(location: 0, length: 0))
    }

    func anchorInputs(for target: NativeTextSelectionTarget) throws -> [AnchorInput] {
        _ = try range(for: target)
        return [target.anchor, target.focus].map {
            AnchorInput(node: $0.node,
                offsetUtf16: richNodes[$0.node]?.attachment == true ? 0 : UInt32($0.offsetUTF16),
                bias: richNodes[$0.node]?.attachment == true && $0.offsetUTF16 == 0 ? .left : .right)
        }
    }
}
