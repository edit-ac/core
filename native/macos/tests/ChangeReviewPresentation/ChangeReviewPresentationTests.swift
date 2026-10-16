import AppKit
import XCTest
@testable import EditacMacOS

@MainActor
final class ChangeReviewPresentationTests: XCTestCase {
    private func scope(_ token: UInt8 = 1, document: String = "native-review", profile: String = "task") -> NativeChangeReviewScope {
        .init(document: document, epoch: "1", schema: "v5", profile: profile,
              revision: Data([1] + Array(repeating: token, count: 64)))
    }
    private func exported(_ id: String) throws -> Data {
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["EDITAC_MACOS_REVIEW_FIXTURE"])
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: XCTUnwrap(root[id]), options: [.sortedKeys])
    }
    private func model(_ id: String = "semantic", attribution: NativeChangeReviewPresentation.Attribution = .unknown) throws -> NativeChangeReviewPresentation {
        try .fromSharedValidatedExport(exported(id), scope: scope(), beforeLabel: "Before 🙂", afterLabel: "After e\u{301}", attribution: attribution)
    }
    private func view(_ id: String = "semantic") throws -> NativeChangeReviewView {
        _ = NSApplication.shared
        let result = NativeChangeReviewView(frame: NSRect(x: 0, y: 0, width: 700, height: 500))
        result.show(try model(id), current: scope())
        addTeardownBlock { @MainActor in result.dispose() }
        return result
    }
    func testExactSourceRetainsWireHashesAndNewlineMetadata() throws {
        let p = try model("source")
        XCTAssertEqual(p.representation, "Exact source (UTF-8 bytes)")
        XCTAssertTrue(p.sections[0].text.contains("before_final_newline"))
        XCTAssertTrue(p.sections[0].text.contains("\r\n"))
        XCTAssertEqual(p.beforeHash.count, 64); XCTAssertEqual(p.afterHash.count, 64)
        XCTAssertTrue(p.sections[0].text.contains(p.beforeHash))
    }
    func testProjectedMarkdownCarriesNormalizationAndVersionLabels() throws {
        let v = try view("projected")
        for text in ["Projected Markdown", "normalized serialization", "editac-markdown-v1", "commonmark"] {
            XCTAssertTrue(v.title.stringValue.contains(text), text)
        }
    }
    func testSemanticFormattingHasIndependentFacet() throws {
        let p = try model("format")
        XCTAssertTrue(p.sections.contains { $0.label.contains("Formatting") })
        XCTAssertTrue(p.sections.contains { $0.text.contains("bold") })
    }
    func testSemanticMovementDoesNotHideOtherFacets() throws {
        let p = try model()
        for facet in ["Placement", "Text", "Formatting", "References", "UnknownModule"] {
            XCTAssertTrue(p.sections.contains { $0.label.contains(facet) }, facet)
        }
    }
    func testOpaquePayloadsAndRetainedStructureRemainInertVisibleText() throws {
        let v = try view()
        XCTAssertTrue(v.textView.string.contains("unknown-widget"))
        XCTAssertTrue(v.textView.string.contains("onerror=alert(1)"))
        XCTAssertTrue(v.textView.string.contains("Retained structure"))
        XCTAssertFalse(v.textView.isRichText)
        XCTAssertFalse(v.textView.isAutomaticLinkDetectionEnabled)
    }
    func testReadOnlyViewRejectsInputDeletionCutPasteAndAccessibilityWrites() throws {
        let v = try view("source"); let before = v.textView.string
        v.textView.setSelectedRange(NSRange(location: 0, length: (before as NSString).length))
        XCTAssertFalse(v.textView.shouldChangeText(in: v.textView.selectedRange(), replacementString: "bad"))
        v.textView.insertText("bad", replacementRange: v.textView.selectedRange())
        v.textView.deleteBackward(nil); v.textView.deleteForward(nil); v.textView.cut(nil); v.textView.paste(nil)
        v.textView.setAccessibilityValue("bad")
        XCTAssertEqual(v.textView.string, before)
        XCTAssertFalse(v.textView.isEditable); XCTAssertNil(v.textView.undoManager)
    }
    func testNativeLabelsExposeProfileScopeRevisionAndUnknownAttribution() throws {
        let v = try view()
        for label in ["Read-only", "native-review", "epoch: 1", "schema: v5", "profile: task", "Before 🙂", "After e\u{301}", "Attribution: unknown"] {
            XCTAssertTrue(v.title.stringValue.contains(label), label)
        }
        XCTAssertEqual(v.textView.accessibilityLabel(), "Read-only change details")
    }
    func testTrustedHostEvidenceIsSeparateFromPortableAttribution() throws {
        let p = try model(attribution: .trustedHostEvidence("signed host event #7"))
        let v = try view(); v.show(p, current: scope())
        XCTAssertTrue(v.title.stringValue.contains("Trusted host evidence: signed host event #7"))
        XCTAssertTrue(p.sections.allSatisfy { !$0.text.contains("signed host event") })
    }
    func testStaleRevisionRemainsVisibleAndNavigable() throws {
        let v = try view(); let content = v.textView.string
        v.observeCurrentScope(scope(2))
        XCTAssertTrue(v.status.stringValue.contains("Stale revision"))
        XCTAssertEqual(v.status.accessibilityLabel(), v.status.stringValue)
        XCTAssertEqual(v.textView.string, content); XCTAssertTrue(v.navigate(to: 0))
        v.observeCurrentScope(scope()); XCTAssertTrue(v.status.stringValue.contains("Current revision"))
    }
    func testDifferentDocumentAndProfileCannotAppearCurrent() throws {
        let v = try view()
        v.observeCurrentScope(scope(document: "other")); XCTAssertTrue(v.status.stringValue.contains("Stale"))
        v.observeCurrentScope(scope(profile: "other")); XCTAssertTrue(v.status.stringValue.contains("Stale"))
        v.observeCurrentScope(nil); XCTAssertTrue(v.status.stringValue.contains("unavailable"))
        XCTAssertFalse(v.textView.string.isEmpty)
    }
    func testUTF16SectionRangesSelectExactDetachedContent() throws {
        let v = try view()
        for (i, section) in try model().sections.enumerated() {
            XCTAssertTrue(v.navigate(to: i))
            XCTAssertEqual(v.textView.selectedRange(), v.ranges[i])
            XCTAssertEqual((v.textView.string as NSString).substring(with: v.ranges[i]), section.label + "\n" + section.text + "\n\n")
        }
        let prior = v.textView.selectedRange()
        XCTAssertFalse(v.navigate(to: -1)); XCTAssertFalse(v.navigate(to: Int.max))
        XCTAssertEqual(v.textView.selectedRange(), prior)
    }
    func testNativeNavigationButtonsRouteWithoutLiveMutationCallback() throws {
        let v = try view()
        let window = NSWindow(contentRect: v.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = v
        defer { window.close() }
        v.next.performClick(nil); XCTAssertEqual(v.selectedChange, 0)
        XCTAssertTrue(window.firstResponder === v.textView)
        XCTAssertFalse(v.previous.isEnabled)
        v.next.performClick(nil); XCTAssertEqual(v.selectedChange, 1)
        v.previous.performClick(nil); XCTAssertEqual(v.selectedChange, 0)
        XCTAssertTrue(v.navigate(to: v.ranges.count - 1)); XCTAssertFalse(v.next.isEnabled)
    }
    func testDisposeClearsOwnedDataAndIgnoresLateUpdates() throws {
        let v = try view(); v.dispose(); v.dispose()
        v.show(try model(), current: scope()); v.observeCurrentScope(scope())
        XCTAssertTrue(v.disposed); XCTAssertNil(v.presentation); XCTAssertTrue(v.textView.string.isEmpty)
        XCTAssertFalse(v.next.isEnabled); XCTAssertFalse(v.previous.isEnabled)
        XCTAssertFalse(v.navigate(to: 0)); XCTAssertEqual(v.status.stringValue, "Disposed")
    }
    func testTwoReviewViewsRetainIndependentSelectionAndStaleness() throws {
        let a = try view(), b = try view("source")
        a.navigate(to: 1); a.observeCurrentScope(scope(2))
        XCTAssertNil(b.selectedChange); XCTAssertTrue(b.status.stringValue.contains("Current revision"))
        a.dispose(); XCTAssertFalse(b.textView.string.isEmpty)
    }
    func testUnknownEnvelopeVersionRejected() throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: exported("semantic")) as? [String: Any])
        json["version"] = "future"
        XCTAssertThrowsError(try NativeChangeReviewPresentation.fromSharedValidatedExport(JSONSerialization.data(withJSONObject: json), scope: scope(), beforeLabel: "a", afterLabel: "b"))
    }
    func testPortableAttributionCannotForgeTrustedEvidence() throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: exported("semantic")) as? [String: Any])
        var input = json["input"] as! [String: Any]; var payload = input["model"] as! [String: Any]
        payload["attribution"] = "trusted Alice"; input["model"] = payload; json["input"] = input
        XCTAssertThrowsError(try NativeChangeReviewPresentation.fromSharedValidatedExport(JSONSerialization.data(withJSONObject: json), scope: scope(), beforeLabel: "a", afterLabel: "b"))
    }
    func testPresentationLimitsRejectBeforeRendering() throws {
        XCTAssertThrowsError(try NativeChangeReviewPresentation.fromSharedValidatedExport(Data(repeating: 32, count: 16 * 1024 * 1024 + 1), scope: scope(), beforeLabel: "a", afterLabel: "b"))
        let invalid = NativeChangeReviewScope(document: "d", epoch: "e", schema: "s", profile: "p", revision: Data())
        XCTAssertThrowsError(try NativeChangeReviewPresentation.fromSharedValidatedExport(exported("source"), scope: invalid, beforeLabel: "a", afterLabel: "b"))
    }
    func testLargeExportRetainsLastLineWithoutTruncation() throws {
        let v = try view("large")
        XCTAssertTrue(v.textView.string.contains("line 4999"))
        XCTAssertTrue(v.navigate(to: 0))
    }
    func testFormattingOnlyAndEmptyComparisonRemainExplicit() throws {
        let v = try view("format")
        XCTAssertTrue(v.textView.string.contains("Formatting"))
        let p = try model("unchanged")
        XCTAssertTrue(p.sections[0].text.contains("editac-exact-patch-v1"))
        v.show(p, current: scope()); XCTAssertTrue(v.title.stringValue.contains("Exact source"))
    }
    func testReloadResetsCapturedRangesAndSelection() throws {
        let v = try view(); v.navigate(to: 1)
        v.show(try model("source"), current: scope())
        XCTAssertEqual(v.ranges.count, 1); XCTAssertNil(v.selectedChange)
        XCTAssertEqual(v.textView.selectedRange(), NSRange(location: 0, length: 0))
        XCTAssertFalse(v.navigate(to: 1))
    }
    func testActualSharedConcurrentExportRetainsCombinedFacets() throws {
        let v = try view("concurrent")
        for text in ["Placement", "Text", "Formatting", "References", "future-mark", "local 🙂"] {
            XCTAssertTrue(v.textView.string.contains(text), text)
        }
        XCTAssertTrue(v.title.stringValue.contains("Attribution: unknown"))
    }
    func testDetachedReviewDoesNotChangeActualSQLiteSessionOrHistory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-review-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let options = NativeSessionOptions(path: directory.appendingPathComponent("document.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil)
        let live = try NativeSession.createLocal(options: options, initial: [.init(kind: "block", text: "Live 🙂 document")])
        defer { try? live.dispose() }
        let before = try live.read(now: 0), history = try live.historyState(now: 0)
        let v = try view("concurrent")
        v.navigate(to: 0); v.observeCurrentScope(nil)
        v.textView.insertText("rewind", replacementRange: NSRange(location: 0, length: 1))
        v.dispose()
        XCTAssertEqual(try live.read(now: 0), before)
        XCTAssertEqual(try live.historyState(now: 0), history)
    }

}
