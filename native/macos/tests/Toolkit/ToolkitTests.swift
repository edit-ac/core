import AppKit
import XCTest
import EditacMacOSProbe

final class ToolkitTests: XCTestCase {
    @MainActor
    private func withProbe(_ body: (ControlCandidateProbe, NSWindow) throws -> Void) rethrows {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 340),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let probe = ControlCandidateProbe(frame: window.contentView!.bounds)
        window.contentView = probe
        window.makeKeyAndOrderFront(nil)
        window.layoutIfNeeded()
        defer {
            window.makeFirstResponder(nil)
            window.contentView = nil
            window.close()
        }
        try body(probe, window)
    }

    @MainActor
    func testExplicitTextKitOneAttributedRangesAndAttachment() throws {
        try withProbe { probe, _ in
            let view = probe.editor.textView
            let storage = try XCTUnwrap(view.textStorage)
            let layout = try XCTUnwrap(view.layoutManager)
            XCTAssertTrue(layout.textStorage === storage)
            XCTAssertTrue(layout.textContainers.first === view.textContainer)
            XCTAssertNil(view.textLayoutManager, "Candidate must remain explicit TextKit 1")
            XCTAssertTrue((view as AnyObject) is NSTextInputClient)
            XCTAssertNotNil(storage.attribute(.attachment, at: 7, effectiveRange: nil))
            storage.addAttribute(.font, value: NSFont.boldSystemFont(ofSize: 16),
                                 range: NSRange(location: 0, length: 6))
            storage.addAttribute(.link, value: URL(string: "https://example.invalid")!,
                                 range: NSRange(location: 9, length: 5))
            XCTAssertEqual((storage.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.fontName,
                           NSFont.boldSystemFont(ofSize: 16).fontName)
            XCTAssertNotNil(storage.attribute(.link, at: 9, effectiveRange: nil))
            let rect = probe.positionAtomControl()
            XCTAssertGreaterThan(rect.width, 0)
            XCTAssertGreaterThan(rect.height, 0)
            XCTAssertTrue(probe.atomSource.window === view.window)
            XCTAssertEqual(probe.atomSource.frame.origin, rect.origin)
        }
    }

    @MainActor
    func testMarkedTextReplacementAndCommitOnNativeInputClient() throws {
        try withProbe { probe, window in
            let view = probe.editor.textView
            view.string = "A😀Z"
            XCTAssertTrue(window.makeFirstResponder(view))
            view.setSelectedRange(NSRange(location: 1, length: 2))
            let unspecified = NSRange(location: NSNotFound, length: 0)
            view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0),
                               replacementRange: unspecified)
            XCTAssertTrue(view.hasMarkedText())
            XCTAssertEqual(view.string, "AにZ")
            XCTAssertEqual(view.markedRange(), NSRange(location: 1, length: 1))
            view.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0),
                               replacementRange: unspecified)
            XCTAssertEqual(view.string, "A日本Z")
            XCTAssertEqual(view.markedRange(), NSRange(location: 1, length: 2))
            view.insertText("日本", replacementRange: unspecified)
            XCTAssertFalse(view.hasMarkedText())
            XCTAssertEqual(view.string, "A日本Z")
            XCTAssertEqual(view.selectedRange(), NSRange(location: 3, length: 0))
            XCTAssertFalse(probe.editProposals.isEmpty)
            XCTAssertGreaterThan(probe.textChangeCount, 0)
            var actual = NSRange()
            let text = view.attributedSubstring(forProposedRange: NSRange(location: 1, length: 2),
                                                actualRange: &actual)
            XCTAssertEqual(text?.string, "日本")
            XCTAssertEqual(actual, NSRange(location: 1, length: 2))
        }
    }

    @MainActor
    func testMarkedTextCanBeClearedWithoutChangingSurroundingText() {
        withProbe { probe, window in
            let view = probe.editor.textView
            view.string = "left right"
            XCTAssertTrue(window.makeFirstResponder(view))
            view.setSelectedRange(NSRange(location: 5, length: 0))
            let unspecified = NSRange(location: NSNotFound, length: 0)
            view.setMarkedText("仮", selectedRange: NSRange(location: 1, length: 0),
                               replacementRange: unspecified)
            view.setMarkedText("", selectedRange: NSRange(location: 0, length: 0),
                               replacementRange: unspecified)
            view.unmarkText()
            XCTAssertFalse(view.hasMarkedText())
            XCTAssertEqual(view.string, "left right")
            XCTAssertEqual(view.selectedRange(), NSRange(location: 5, length: 0))
            // This is protocol feasibility. A later session adapter restores a
            // captured replacement target on cancel; unmarkText alone accepts it.
        }
    }

    @MainActor
    func testNativeDelegateCanRejectCommittedReplacementAndObserveSelection() {
        withProbe { probe, window in
            let view = probe.editor.textView
            view.string = "A😀Z"
            XCTAssertTrue(window.makeFirstResponder(view))
            view.setSelectedRange(NSRange(location: 1, length: 2))
            XCTAssertGreaterThan(probe.selectionChangeCount, 0)
            probe.acceptsEdits = false
            view.insertText("replacement", replacementRange: NSRange(location: 1, length: 2))
            XCTAssertEqual(probe.editProposals.last, NSRange(location: 1, length: 2))
            XCTAssertEqual(view.string, "A😀Z")
            XCTAssertEqual(view.selectedRange(), NSRange(location: 1, length: 2))
            XCTAssertFalse(view.allowsUndo)
        }
    }

    @MainActor
    func testRealTableCellRespondersEditComposeAndTransferFocus() {
        withProbe { probe, window in
            let first = probe.cells[0].textView
            let second = probe.cells[1].textView
            XCTAssertTrue(first.window === window)
            XCTAssertTrue(second.window === window)
            XCTAssertTrue(window.makeFirstResponder(first))
            first.setSelectedRange(NSRange(location: 0, length: first.string.utf16.count))
            first.insertText("😀 cell", replacementRange: NSRange(location: NSNotFound, length: 0))
            XCTAssertEqual(first.string, "😀 cell")
            XCTAssertEqual(second.string, "Cell 1")
            window.selectNextKeyView(first)
            XCTAssertTrue(window.firstResponder === second)
            second.setSelectedRange(NSRange(location: 0, length: second.string.utf16.count))
            second.setMarkedText("表", selectedRange: NSRange(location: 1, length: 0),
                                 replacementRange: NSRange(location: NSNotFound, length: 0))
            XCTAssertTrue(second.hasMarkedText())
            second.insertText("表", replacementRange: NSRange(location: NSNotFound, length: 0))
            XCTAssertEqual(second.string, "表")
            XCTAssertFalse(second.hasMarkedText())
            XCTAssertEqual(first.string, "😀 cell")
            XCTAssertTrue(probe.grid.cell(atColumnIndex: 0, rowIndex: 0).contentView === probe.cells[0])
        }
    }

    @MainActor
    func testAttachmentSelectionAndRealNativeAtomSourceEditor() throws {
        try withProbe { probe, window in
            let view = probe.editor.textView
            probe.positionAtomControl()
            view.setSelectedRange(probe.atomRange)
            XCTAssertEqual(view.selectedRange(), probe.atomRange)
            XCTAssertEqual((view.string as NSString).substring(with: probe.atomRange), "\u{FFFC}")
            XCTAssertTrue(window.makeFirstResponder(probe.atomSource))
            let input = try XCTUnwrap(probe.atomSource.currentEditor() as? NSTextView)
            XCTAssertTrue(input.isFieldEditor)
            input.setSelectedRange(NSRange(location: 0, length: input.string.utf16.count))
            input.insertText("x³ + 1", replacementRange: NSRange(location: NSNotFound, length: 0))
            XCTAssertTrue(window.makeFirstResponder(view))
            XCTAssertEqual(probe.atomSource.stringValue, "x³ + 1")
            XCTAssertNotNil(view.textStorage?.attribute(.attachment, at: 7, effectiveRange: nil))
            XCTAssertEqual(view.string, "Before \u{FFFC} after")
            XCTAssertTrue(probe.atomSource.superview === view)
            // Field editing and attachment identity are proven; committing source
            // through shared commands and reflow/undo belong to later owners.
        }
    }
}
