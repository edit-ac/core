import AppKit

public enum NativeProjectionFailure: Error, Equatable {
    case disposed, unavailableRevision, staleTarget, invalidRange, duplicateIdentity
    case unsupportedKind(String)
    case malformedRichProjection, invalidCursor
}

/// Presentation identity only. The shared Session remains the only document.
@MainActor
public final class NativeTextNodeProjection {
    public let id: String
    public internal(set) var text: String
    public internal(set) var range: NSRange
    init(id: String, text: String, range: NSRange) {
        self.id = id; self.text = text; self.range = range
    }
}

public struct NativeTextEndpoint: Equatable, Sendable {
    public let node: String
    public let offsetUTF16: Int
}

/// A revision-scoped coordinate, deliberately not a CRDT/stable anchor. Changed
/// revisions are rejected; the view captures shared anchors before async work.
public struct NativeTextSelectionTarget: Equatable, Sendable {
    let owner: UUID
    public let revision: Data
    public let anchor: NativeTextEndpoint
    public let focus: NativeTextEndpoint
    public let affinity: NSSelectionAffinity
}

public struct NativeTextStoragePatch: Equatable {
    public let range: NSRange
    public let replacement: String
}

/// Native UTF-16 coordinate and storage projection, fed by rich Session patches.
/// Reads actual Session values; never constructs an engine or issues a command.
@MainActor
public final class NativeTextProjection {
    let textView: NSTextView
    let owner = UUID()
    var disposed = false
    var revision: Data?
    var selectedTarget: NativeTextSelectionTarget?
    public internal(set) var nodes: [NativeTextNodeProjection] = []
    public internal(set) var lastPatch: NativeTextStoragePatch?
    public internal(set) var selectionInvalidated = false
    public var selection: NativeTextSelectionTarget? { selectedTarget }
    let styleRegistry = NativeStyleRegistry()
    var richNodes: [String: RichProjectionNode] = [:]
    var richSequence: UInt64?
    var richIdentity: Data?
    var anchoredSelection = false
    public internal(set) var selectionResolutions: [NativeSessionAnchorRead] = []
    public internal(set) var attachmentIdentities: [String: NSTextAttachment] = [:]

    public init(textView: NSTextView) { self.textView = textView }

    public func apply(_ snapshot: NativeSessionRead) throws {
        guard !disposed else { throw NativeProjectionFailure.disposed }
        var ids = Set<String>()
        var nextRanges: [String: NSRange] = [:]
        var length = 0
        for node in snapshot.nodes {
            guard ids.insert(node.id).inserted else { throw NativeProjectionFailure.duplicateIdentity }
            guard node.kind == "block" else { throw NativeProjectionFailure.unsupportedKind(node.kind) }
            nextRanges[node.id] = NSRange(location: length, length: node.text.utf16.count)
            length += node.text.utf16.count + 1
        }
        let nextText = snapshot.nodes.map(\.text).joined(separator: "\n")
        // Retain endpoint offsets only when that entire node's text is unchanged.
        // Changed-node remapping requires shared anchors, never a local diff oracle.
        let currentSelection = selectedTarget.flatMap { target in
            (try? range(for: target)) == textView.selectedRange() ? target : nil
        } ?? (try? capture(range: textView.selectedRange(), backwards: false,
                          affinity: textView.selectionAffinity))
        let oldNodes = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        var nextSelection: NSRange?
        if let selection = currentSelection {
            func remap(_ endpoint: NativeTextEndpoint) -> Int? {
                guard let next = snapshot.nodes.first(where: { $0.id == endpoint.node }),
                      let old = oldNodes[endpoint.node],
                      old.text.utf16.elementsEqual(next.text.utf16),
                      let range = nextRanges[endpoint.node] else { return nil }
                return range.location + endpoint.offsetUTF16
            }
            if let anchor = remap(selection.anchor), let focus = remap(selection.focus) {
                nextSelection = NSRange(location: min(anchor, focus), length: abs(anchor - focus))
            }
        }
        let patch = Self.patch(from: textView.string, to: nextText)
        if let patch {
            textView.textStorage?.replaceCharacters(in: patch.range, with: patch.replacement)
        }
        nodes = snapshot.nodes.map { node in
            let projected = oldNodes[node.id] ?? NativeTextNodeProjection(
                id: node.id, text: node.text, range: nextRanges[node.id]!)
            projected.text = node.text
            projected.range = nextRanges[node.id]!
            return projected
        }
        revision = snapshot.revision
        lastPatch = patch
        selectionInvalidated = currentSelection != nil && nextSelection == nil
        if let nextSelection, let prior = currentSelection {
            textView.setSelectedRange(nextSelection, affinity: prior.affinity, stillSelecting: false)
            // Endpoint identity determines direction independently of caret affinity.
            if let revision {
                selectedTarget = NativeTextSelectionTarget(owner: owner, revision: revision,
                    anchor: prior.anchor, focus: prior.focus, affinity: prior.affinity)
            }
        } else {
            textView.setSelectedRange(NSRange(location: 0, length: 0))
            selectedTarget = nil
        }
    }

    /// The input owner supplies anchor/focus direction. AppKit's affinity is a
    /// separate bidi/caret property and must never be interpreted as direction.
    public func capture(range: NSRange, backwards: Bool,
                        affinity: NSSelectionAffinity) throws -> NativeTextSelectionTarget {
        guard !disposed else { throw NativeProjectionFailure.disposed }
        guard let revision else { throw NativeProjectionFailure.unavailableRevision }
        guard range.location != NSNotFound, range.location >= 0, range.length >= 0,
              range.location <= textView.string.utf16.count,
              range.length <= textView.string.utf16.count - range.location,
              let start = endpoint(at: range.location),
              let end = endpoint(at: range.location + range.length) else {
            throw NativeProjectionFailure.invalidRange
        }
        return NativeTextSelectionTarget(owner: owner, revision: revision,
            anchor: backwards ? end : start, focus: backwards ? start : end, affinity: affinity)
    }

    public func range(for target: NativeTextSelectionTarget) throws -> NSRange {
        guard !disposed else { throw NativeProjectionFailure.disposed }
        guard target.owner == owner, target.revision == revision else {
            throw NativeProjectionFailure.staleTarget
        }
        func position(_ endpoint: NativeTextEndpoint) throws -> Int {
            guard let node = nodes.first(where: { $0.id == endpoint.node }),
                  Self.isBoundary(endpoint.offsetUTF16, in: node.text) else {
                throw NativeProjectionFailure.invalidRange
            }
            return node.range.location + endpoint.offsetUTF16
        }
        let anchor = try position(target.anchor), focus = try position(target.focus)
        return NSRange(location: min(anchor, focus), length: abs(anchor - focus))
    }

    public func select(_ target: NativeTextSelectionTarget) throws {
        let range = try range(for: target)
        textView.setSelectedRange(range, affinity: target.affinity, stillSelecting: false)
        selectedTarget = target
        anchoredSelection = false
    }

    public func dispose() {
        disposed = true; selectedTarget = nil; revision = nil
        styleRegistry.dispose()
        richNodes = [:]; attachmentIdentities = [:]; anchoredSelection = false
    }

    func endpoint(at offset: Int) -> NativeTextEndpoint? {
        for node in nodes where offset >= node.range.location && offset <= NSMaxRange(node.range) {
            let local = offset - node.range.location
            guard Self.isBoundary(local, in: node.text) else { return nil }
            return NativeTextEndpoint(node: node.id, offsetUTF16: local)
        }
        return nil
    }

    static func isBoundary(_ offset: Int, in text: String) -> Bool {
        let units = Array(text.utf16)
        guard offset >= 0, offset <= units.count else { return false }
        return offset == 0 || offset == units.count ||
            !(0xD800...0xDBFF).contains(units[offset - 1]) || !(0xDC00...0xDFFF).contains(units[offset])
    }

    /// Scalar-aligned presentation diff, not a semantic edit or anchor transform.
    static func patch(from old: String, to new: String) -> NativeTextStoragePatch? {
        guard !old.unicodeScalars.elementsEqual(new.unicodeScalars) else { return nil }
        let left = Array(old.unicodeScalars), right = Array(new.unicodeScalars)
        var prefix = 0, suffix = 0
        while prefix < min(left.count, right.count), left[prefix] == right[prefix] { prefix += 1 }
        while suffix < min(left.count, right.count) - prefix,
              left[left.count - 1 - suffix] == right[right.count - 1 - suffix] { suffix += 1 }
        func string(_ scalars: ArraySlice<Unicode.Scalar>) -> String {
            String(String.UnicodeScalarView(scalars))
        }
        return NativeTextStoragePatch(range: NSRange(location: string(left[..<prefix]).utf16.count,
            length: string(left[prefix..<(left.count - suffix)]).utf16.count),
            replacement: string(right[prefix..<(right.count - suffix)]))
    }
}
