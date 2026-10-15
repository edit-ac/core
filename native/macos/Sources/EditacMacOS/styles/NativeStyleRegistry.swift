import AppKit

/// Presentation of the qualified shared descriptors. No native attribute is an
/// editing command or a serialization source; the original wire stays attached.
@MainActor
final class NativeStyleRegistry {
    private var listObjects: [String: NSTextList] = [:]

    func retainContainers(in nodes: [String: RichProjectionNode]) {
        listObjects = listObjects.filter { nodes[$0.key]?.kind == "list" }
    }
    func dispose() { listObjects.removeAll() }
    nonisolated static let listMarker = NSAttributedString.Key("ac.native.list-marker")
    nonisolated static let quoteDepth = NSAttributedString.Key("ac.native.quote-depth")
    static let ownedKeys: [NSAttributedString.Key] = [
        .font, .foregroundColor, .backgroundColor, .underlineStyle,
        .strikethroughStyle, .link, .paragraphStyle, listMarker, quoteDepth,
    ]

    static func ancestors(of node: RichProjectionNode, in nodes: [String: RichProjectionNode]) -> [RichProjectionNode] {
        var result: [RichProjectionNode] = []
        var parent = node.wire["parent"] as? String
        var seen = Set<String>()
        while let id = parent, let value = nodes[id], seen.insert(id).inserted {
            result.append(value); parent = value.wire["parent"] as? String
        }
        return result.reversed()
    }

    func apply(_ node: RichProjectionNode, nodes: [String: RichProjectionNode],
                      range: NSRange, paragraphRange: NSRange, storage: NSTextStorage) -> [NSAttributedString.Key: Any] {
        for key in Self.ownedKeys { storage.removeAttribute(key, range: paragraphRange) }
        let tuple = node.wire["blockAttributes"] as? [Any] ?? []
        let kind = tuple.first as? String ?? "paragraph"
        let heading = kind == "heading" ? (tuple.dropFirst().first as? Int ?? 1) : 0
        let baseSize: CGFloat = heading > 0 ? [28, 24, 21, 19, 17, 15][max(0, min(5, heading - 1))] : 14
        let paragraph = NSMutableParagraphStyle()
        paragraph.paragraphSpacing = heading > 0 ? 8 : 4
        var lists: [NSTextList] = []
        var marker: String?
        var quotes = 0
        for container in Self.ancestors(of: node, in: nodes) {
            let editor = container.wire["editor"] as? [String: Any]
            let attributes = editor?["containerAttributes"] as? [Any] ?? []
            let style = attributes.first as? String
            if style == "quote" { quotes += 1; continue }
            let format: NSTextList.MarkerFormat
            switch style {
            case "ordered": format = .decimal
            case "checklist": format = .init(rawValue: "{box}")
            default: format = .disc
            }
            let start = style == "ordered" ? (attributes.dropFirst().first as? Int ?? 1) : 1
            let list: NSTextList
            if let retained = listObjects[container.id], retained.markerFormat == format,
               retained.startingItemNumber == start { list = retained }
            else {
                list = NSTextList(markerFormat: format, options: 0)
                list.startingItemNumber = start; listObjects[container.id] = list
            }
            lists.append(list)
            if style == "checklist" {
                let checked = (node.wire["editor"] as? [String: Any])?["checked"] as? Bool ?? false
                marker = checked ? "☑" : "☐"
            } else {
                let number = (node.wire["editor"] as? [String: Any])?["number"] as? Int ?? list.startingItemNumber
                marker = style == "ordered" ? "\(number)." : "•"
            }
        }
        paragraph.textLists = lists
        paragraph.headIndent = CGFloat(lists.count + quotes) * 24
        paragraph.firstLineHeadIndent = paragraph.headIndent
        storage.addAttribute(.paragraphStyle, value: paragraph.copy() as! NSParagraphStyle, range: paragraphRange)
        if let marker {
            storage.addAttribute(Self.listMarker, value: marker,
                                 range: NSRange(location: paragraphRange.location, length: min(1, paragraphRange.length)))
        }
        if quotes > 0 { storage.addAttribute(Self.quoteDepth, value: quotes, range: paragraphRange) }
        storage.addAttributes([.font: NSFont.systemFont(ofSize: baseSize), .foregroundColor: NSColor.labelColor], range: paragraphRange)
        var defaults: [NSAttributedString.Key: Any] = [.font: kind == "code" ? NSFont.monospacedSystemFont(ofSize: baseSize, weight: .regular) : NSFont.systemFont(ofSize: baseSize, weight: heading > 0 ? .bold : .regular), .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph.copy() as! NSParagraphStyle]
        if let marker { defaults[Self.listMarker] = marker }
        if quotes > 0 { defaults[Self.quoteDepth] = quotes }
        guard !node.attachment else { return defaults }
        var offset = range.location
        for run in node.runs {
            let attributes = run["attributes"] as! [String: Any]
            let length = (run["text"] as! String).utf16.count
            let local = NSRange(location: offset, length: length)
            var font = kind == "code" || attributes["code"] as? Bool == true
                ? NSFont.monospacedSystemFont(ofSize: baseSize, weight: .regular)
                : NSFont.systemFont(ofSize: baseSize)
            var traits: NSFontTraitMask = []
            if heading > 0 || attributes["bold"] as? Bool == true { traits.insert(.boldFontMask) }
            if attributes["italic"] as? Bool == true { traits.insert(.italicFontMask) }
            font = NSFontManager.shared.convert(font, toHaveTrait: traits)
            storage.addAttribute(.font, value: font, range: local)
            if attributes["underline"] as? Bool == true { storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: local) }
            if attributes["strike"] as? Bool == true { storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: local) }
            if attributes["code"] as? Bool == true || kind == "code" { storage.addAttribute(.backgroundColor, value: NSColor.quaternaryLabelColor, range: local) }
            if let href = attributes["link"] as? String, let url = URL(string: href),
               ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                storage.addAttributes([.link: url, .foregroundColor: NSColor.linkColor,
                                       .underlineStyle: NSUnderlineStyle.single.rawValue], range: local)
            }
            offset += length
        }
        return range.length > 0 ? storage.attributes(at: range.location, effectiveRange: nil) : defaults
    }
}

/// TextKit 1 does not synthesize list-marker characters from paragraph metadata.
/// Draw native gutter glyphs instead of injecting editable text/UTF-16 offsets.
final class NativeStyledLayoutManager: NSLayoutManager {
    var trailingPresentation: [NSAttributedString.Key: Any] = [:]

    override func drawGlyphs(forGlyphRange glyphs: NSRange, at origin: NSPoint) {
        super.drawGlyphs(forGlyphRange: glyphs, at: origin)
        guard let storage = textStorage, let container = textContainers.first else { return }
        let characters = characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let string = storage.string as NSString
        var start = string.paragraphRange(for: NSRange(location: characters.location, length: 0)).location
        while start < NSMaxRange(characters) && start < storage.length {
            defer { start = NSMaxRange(string.paragraphRange(for: NSRange(location: start, length: 0))) }
            let glyph = self.glyphIndexForCharacter(at: start)
            let line = self.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let location = self.location(forGlyphAt: glyph)
            let point = NSPoint(x: origin.x + line.minX + location.x - 21, y: origin.y + line.minY)
            if let marker = storage.attribute(NativeStyleRegistry.listMarker, at: start, effectiveRange: nil) as? String {
                (marker as NSString).draw(at: point, withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.labelColor])
            }
            if let depth = storage.attribute(NativeStyleRegistry.quoteDepth, at: start, effectiveRange: nil) as? Int {
                NSColor.separatorColor.setFill()
                for level in 0..<depth {
                    NSRect(x: origin.x + container.lineFragmentPadding + CGFloat(level) * 24 + 4,
                           y: origin.y + line.minY, width: 2, height: line.height).fill()
                }
            }
        }
        if (storage.length == 0 || storage.string.hasSuffix("\n")),
           let marker = trailingPresentation[NativeStyleRegistry.listMarker] as? String,
           let paragraph = trailingPresentation[.paragraphStyle] as? NSParagraphStyle {
            let point = NSPoint(x: origin.x + container.lineFragmentPadding + paragraph.headIndent - 21,
                                y: origin.y + extraLineFragmentRect.minY)
            (marker as NSString).draw(at: point, withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.labelColor])
        }
    }
}
