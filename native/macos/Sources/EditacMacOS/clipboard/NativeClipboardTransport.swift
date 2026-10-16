import AppKit

/// Transport identifiers only. Rust's transfer owner validates the contents;
/// declaring a pasteboard type never grants schema or session authority.
public enum NativeClipboardFlavor: String, CaseIterable, Sendable {
    case fragment = "ac.editac.fragment-json"
    case extensionOffer = "ac.editac.extension-transfer-json"
    case markdown = "net.daringfireball.markdown"
    case html = "public.html"
    case rtf = "public.rtf"
    case plain = "public.utf8-plain-text"

    public var pasteboardType: NSPasteboard.PasteboardType { .init(rawValue) }
    public var mimeType: String {
        switch self {
        case .fragment: return "application/x-edit-ac-fragment+json"
        case .extensionOffer: return "application/x-edit-ac-extension+json"
        case .markdown: return "text/markdown"
        case .html: return "text/html"
        case .rtf: return "text/rtf"
        case .plain: return "text/plain"
        }
    }
}

public enum NativeClipboardFailure: Error, Equatable, Sendable {
    case emptyOffer, oversized, invalidUTF8(NativeClipboardFlavor)
    case unsupportedTypes, multipleItems, changedDuringRead, writeRefused
    case cancelled, alreadyConsumed, unavailableTarget, staleTarget, readOnly
    case providerFailed
}

/// Owned bytes, independent of a source control, session, or lazy host codec.
/// This is an untrusted transport envelope, not an admitted engine fragment.
public struct NativeClipboardOffer: Sendable, Equatable {
    public static let maximumFlavorBytes = 1_048_576
    public static let maximumBytes = maximumFlavorBytes * NativeClipboardFlavor.allCases.count
    public let values: [NativeClipboardFlavor: Data]

    public init(_ values: [NativeClipboardFlavor: Data]) throws {
        guard !values.isEmpty else { throw NativeClipboardFailure.emptyOffer }
        var total = 0
        for (flavor, bytes) in values {
            guard bytes.count <= Self.maximumFlavorBytes,
                  bytes.count <= Self.maximumBytes - total else { throw NativeClipboardFailure.oversized }
            total += bytes.count
            if flavor != .rtf && String(data: bytes, encoding: .utf8) == nil {
                throw NativeClipboardFailure.invalidUTF8(flavor)
            }
        }
        self.values = values
    }

    /// Literal mode never calls a rich codec. Rich candidates retain their exact
    /// bytes for shared validation/fallback; no native parser guesses semantics.
    public func candidates(literal: Bool) -> [NativeClipboardFlavor] {
        (literal ? [.plain] : NativeClipboardFlavor.allCases).filter { values[$0] != nil }
    }
}

private final class OwnedClipboardProvider: NSObject, NSPasteboardItemDataProvider {
    let values: [String: Data]
    init(_ offer: NativeClipboardOffer) {
        values = Dictionary(uniqueKeysWithValues: offer.values.map { ($0.key.rawValue, $0.value) })
    }
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem,
                    provideDataForType type: NSPasteboard.PasteboardType) {
        if let bytes = values[type.rawValue] { item.setData(bytes, forType: type) }
    }
}

/// OS acknowledgement only, never a destination commit or permission to delete.
/// Retaining this object keeps the immutable provider alive after source disposal.
@MainActor
public final class NativeClipboardPublication {
    public let changeCount: Int
    public let pasteboardName: NSPasteboard.Name
    private let provider: OwnedClipboardProvider?
    private let offer: NativeClipboardOffer
    fileprivate init(board: NSPasteboard, offer: NativeClipboardOffer, provider: OwnedClipboardProvider?) {
        changeCount = board.changeCount; pasteboardName = board.name
        self.offer = offer; self.provider = provider
    }
    public func isCurrent(on board: NSPasteboard) -> Bool {
        guard board.name == pasteboardName, board.changeCount == changeCount,
              let read = try? NativeClipboardTransport.read(from: board) else { return false }
        return board.changeCount == changeCount && read == offer
    }
}

@MainActor
public enum NativeClipboardTransport {
    /// All flavors are staged before touching the board. Failure never requests
    /// source deletion; P3 must separately revalidate and commit the shared cut.
    public static func publish(_ offer: NativeClipboardOffer, to board: NSPasteboard,
                               promised: Bool = false) throws -> NativeClipboardPublication {
        guard offer.values[.plain] != nil else { throw NativeClipboardFailure.unsupportedTypes }
        let item = NSPasteboardItem()
        let types = offer.candidates(literal: false).map(\.pasteboardType)
        let provider = promised ? OwnedClipboardProvider(offer) : nil
        if let provider {
            guard item.setDataProvider(provider, forTypes: types) else { throw NativeClipboardFailure.writeRefused }
        } else {
            for flavor in offer.candidates(literal: false) {
                guard item.setData(offer.values[flavor]!, forType: flavor.pasteboardType) else {
                    throw NativeClipboardFailure.writeRefused
                }
            }
        }
        board.clearContents()
        guard board.writeObjects([item]) else { throw NativeClipboardFailure.writeRefused }
        let publication = NativeClipboardPublication(board: board, offer: offer, provider: provider)
        // Materialize/verify every promised flavor before acknowledging a cut.
        guard publication.isCurrent(on: board) else { throw NativeClipboardFailure.writeRefused }
        return publication
    }

    public static func read(from board: NSPasteboard) throws -> NativeClipboardOffer {
        let generation = board.changeCount
        guard let items = board.pasteboardItems, !items.isEmpty else { throw NativeClipboardFailure.emptyOffer }
        guard items.count == 1 else { throw NativeClipboardFailure.multipleItems }
        var values: [NativeClipboardFlavor: Data] = [:]
        var total = 0
        for flavor in NativeClipboardFlavor.allCases where items[0].types.contains(flavor.pasteboardType) {
            guard let bytes = items[0].data(forType: flavor.pasteboardType) else {
                throw NativeClipboardFailure.providerFailed
            }
            guard bytes.count <= NativeClipboardOffer.maximumFlavorBytes,
                  bytes.count <= NativeClipboardOffer.maximumBytes - total else { throw NativeClipboardFailure.oversized }
            total += bytes.count; values[flavor] = bytes
        }
        guard board.changeCount == generation else { throw NativeClipboardFailure.changedDuringRead }
        guard !values.isEmpty else { throw NativeClipboardFailure.unsupportedTypes }
        return try NativeClipboardOffer(values)
    }
}
