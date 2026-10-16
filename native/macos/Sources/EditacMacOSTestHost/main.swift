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
        let chrome = NSView(frame: window.contentView!.bounds)
        editor.frame = NSRect(x: 0, y: 44, width: chrome.bounds.width, height: chrome.bounds.height - 44)
        editor.autoresizingMask = [.width, .height]
        editor.storage.statusLabel.frame = NSRect(x: 6, y: 2, width: chrome.bounds.width - 12, height: 20)
        editor.collaboration.statusLabel.frame = NSRect(x: 6, y: 22, width: chrome.bounds.width - 12, height: 20)
        editor.storage.statusLabel.autoresizingMask = [.width]
        editor.collaboration.statusLabel.autoresizingMask = [.width]
        chrome.addSubview(editor)
        chrome.addSubview(editor.storage.statusLabel)
        chrome.addSubview(editor.collaboration.statusLabel)
        window.contentView = chrome
        self.window = window
        if let index = CommandLine.arguments.firstIndex(of: "--yield-activation"),
           CommandLine.arguments.count > index + 2,
           let pid = Int32(CommandLine.arguments[index + 1]),
           let target = NSRunningApplication(processIdentifier: pid) {
            let receipt = URL(fileURLWithPath: CommandLine.arguments[index + 2])
            window.makeKeyAndOrderFront(nil)
            var attempts = 0
            Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { timer in
                let done = MainActor.assumeIsolated {
                    attempts += 1
                    // This fixture must first own foreground activation before
                    // yielding it. A background app's default activation request
                    // can remain denied even after its window is ordered front.
                    NSApp.activate(ignoringOtherApps: true)
                    if NSApp.isActive || attempts >= 150 {
                        let active = NSApp.isActive
                        if active { NSApp.yieldActivation(to: target) }
                        let value: [String: Any] = ["helperPID": ProcessInfo.processInfo.processIdentifier,
                            "targetPID": pid, "activeBeforeYield": active,
                            "targetExecutable": target.executableURL?.path ?? "", "attempts": attempts]
                        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
                            try? data.write(to: receipt, options: .atomic)
                        }
                        NSApp.terminate(nil)
                        return true
                    }
                    return false
                }
                if done { timer.invalidate() }
            }
        } else         if CommandLine.arguments.contains("--smoke") {
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
application.setActivationPolicy(CommandLine.arguments.contains("--yield-activation") ? .regular : .accessory)
let delegate = HostDelegate()
application.delegate = delegate
application.run()
