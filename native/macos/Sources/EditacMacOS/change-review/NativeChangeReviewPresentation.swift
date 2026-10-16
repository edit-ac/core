import Foundation

/// Detached presentation only. Construction is internal until the shared native
/// validator/revision bridge is qualified. This is never an edit capability.
struct NativeChangeReviewScope: Equatable {
    let document: String
    let epoch: String
    let schema: String
    let profile: String
    let revision: Data
}

struct NativeChangeReviewPresentation {
    struct Section {
        let label: String
        let text: String
    }
    enum Attribution {
        case unknown
        /// Supplied by a trusted host independently of portable diff data.
        case trustedHostEvidence(String)
        var label: String {
            switch self {
            case .unknown: return "Attribution: unknown"
            case .trustedHostEvidence(let evidence): return "Trusted host evidence: " + evidence
            }
        }
    }
    enum Failure: Error { case invalid, limit, unsupported }
    let scope: NativeChangeReviewScope
    let beforeLabel: String
    let afterLabel: String
    let representation: String
    let beforeHash: String
    let afterHash: String
    let attribution: Attribution
    let sections: [Section]

    /// Only consumes bytes already validated/exported by editac-diff. The native
    /// checks below protect presentation bounds and do NOT replace shared decode.
    /// Tests supply canonical Rust exports; no public unvalidated JSON entry exists.
    static func fromSharedValidatedExport(_ data: Data, scope: NativeChangeReviewScope,
        beforeLabel: String, afterLabel: String, attribution: Attribution = .unknown) throws -> Self {
        guard data.count <= 16 * 1024 * 1024 else { throw Failure.limit }
        guard !scope.document.isEmpty, !scope.epoch.isEmpty, !scope.schema.isEmpty,
              !scope.profile.isEmpty, scope.revision.count == 65, scope.revision.first == 1,
              [scope.document, scope.epoch, scope.schema, scope.profile, beforeLabel, afterLabel]
                .allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else { throw Failure.invalid }
        if case .trustedHostEvidence(let text) = attribution {
            guard !text.isEmpty, text.utf8.count <= 1024 else { throw Failure.invalid }
        }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == ["version", "input"],
              root["version"] as? String == "editac-change-model-v1",
              let input = root["input"] as? [String: Any],
              let type = input["representation"] as? String else { throw Failure.unsupported }
        let representation: String
        let sections: [Section]
        let beforeHash: String
        let afterHash: String
        switch type {
        case "exact-source", "projected-markdown":
            let expected: Set<String> = type == "exact-source" ? ["representation", "wire"]
                : ["representation", "wire", "serializer", "dialect"]
            guard Set(input.keys) == expected, let wire = input["wire"] as? String,
                  let newline = wire.firstIndex(of: "\n"),
                  wire.hasPrefix("# editac-exact-patch-v1 ") else { throw Failure.invalid }
            let header = String(wire[..<newline].dropFirst("# editac-exact-patch-v1 ".count))
            guard let bytes = header.data(using: .utf8),
                  let metadata = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let before = metadata["before_hash"] as? String,
                  let after = metadata["after_hash"] as? String else { throw Failure.invalid }
            beforeHash = before; afterHash = after
            if type == "projected-markdown" {
                guard let serializer = input["serializer"] as? String, !serializer.isEmpty,
                      let dialect = input["dialect"] as? String, !dialect.isEmpty else { throw Failure.invalid }
                representation = "Projected Markdown — normalized serialization; \(serializer); \(dialect)"
            } else { representation = "Exact source (UTF-8 bytes)" }
            // Keep metadata/newline flags and unified line coordinates verbatim.
            // They are never converted into live editor offsets.
            sections = [Section(label: "Unified changes", text: wire)]
        case "semantic":
            guard Set(input.keys) == ["representation", "model"],
                  let model = input["model"] as? [String: Any],
                  Set(model.keys) == ["version", "before_hash", "after_hash", "attribution", "changes", "retained_structure"],
                  model["version"] as? String == "editac-semantic-diff-v1",
                  model["attribution"] as? String == "unknown",
                  let before = model["before_hash"] as? String,
                  let after = model["after_hash"] as? String,
                  let changes = model["changes"] as? [[String: Any]], changes.count <= 10_001 else { throw Failure.invalid }
            beforeHash = before; afterHash = after
            representation = "Semantic snapshot (content, formatting and structure)"
            var rows: [Section] = []
            var ids = Set<String>()
            for change in changes {
                guard Set(change.keys) == ["id", "facets", "before", "after"],
                      let id = change["id"] as? String, !id.isEmpty, ids.insert(id).inserted,
                      let facets = change["facets"] as? [String], !facets.isEmpty,
                      Set(facets).count == facets.count else { throw Failure.invalid }
                rows.append(Section(label: id + ": " + facets.joined(separator: ", "),
                    text: try json(change)))
            }
            if let retained = model["retained_structure"], !(retained is NSNull) {
                rows.append(Section(label: "Retained structure", text: try json(retained)))
            }
            sections = rows
        default: throw Failure.unsupported
        }
        let isHash: (String) -> Bool = { $0.utf8.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
        guard isHash(beforeHash), isHash(afterHash) else { throw Failure.invalid }
        return Self(scope: scope, beforeLabel: beforeLabel, afterLabel: afterLabel,
            representation: representation, beforeHash: beforeHash, afterHash: afterHash,
            attribution: attribution, sections: sections)
    }

    private static func json(_ value: Any) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
        guard let text = String(data: bytes, encoding: .utf8) else { throw Failure.invalid }
        return text
    }
}
