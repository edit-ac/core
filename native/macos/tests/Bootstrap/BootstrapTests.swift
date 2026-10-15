import AppKit
import XCTest
@testable import EditacMacOS

final class BootstrapTests: XCTestCase {
    @MainActor
    func testNativeControlMountsInAppKitWindow() throws {
        _ = NSApplication.shared
        XCTAssertTrue(Thread.isMainThread)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let editor = NativeEditorView(frame: window.contentView!.bounds)
        window.contentView = editor
        window.layoutIfNeeded()
        XCTAssertTrue((editor.textView as AnyObject) is NSTextInputClient)
        XCTAssertTrue(editor.textView.window === window)
        XCTAssertTrue(editor.scrollView.documentView === editor.textView)
        XCTAssertNotNil(editor.textView.textStorage)
        XCTAssertNotNil(editor.textView.layoutManager)
        XCTAssertEqual(editor.scrollView.frame, editor.bounds)
        XCTAssertGreaterThan(editor.textView.bounds.width, 0)
        XCTAssertGreaterThan(editor.textView.bounds.height, 0)
        XCTAssertEqual(editor.textView.string, "")
        XCTAssertTrue(editor.textView.isSelectable)
        XCTAssertFalse(editor.textView.isEditable)
        XCTAssertFalse(editor.textView.allowsUndo)
        XCTAssertEqual(editor.textView.accessibilityLabel(), "Editor (session unavailable)")
        window.contentView = nil
        XCTAssertNil(editor.textView.window)
    }
}
