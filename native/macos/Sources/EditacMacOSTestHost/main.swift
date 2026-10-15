import AppKit
import EditacMacOS

@MainActor
final class HostDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 400),
                              styleMask: [.titled, .closable, .resizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Editac native SDK test host — unqualified"
        let editor = NativeEditorView(frame: window.contentView!.bounds)
        window.contentView = editor
        self.window = window
        if CommandLine.arguments.contains("--smoke") {
            window.layoutIfNeeded()
            guard editor.textView.window === window,
                  editor.scrollView.documentView === editor.textView,
                  !editor.textView.isEditable else {
                print("Native host mount failed")
                exit(1)
            }
            print("EDITAC_NATIVE_HOST_SMOKE_PASS")
            window.close()
            NSApplication.shared.terminate(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = HostDelegate()
application.delegate = delegate
application.run()
