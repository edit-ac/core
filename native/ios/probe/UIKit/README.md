# UIKit/TextKit preparation control

NAT-1.5 uses `Probe.swift` and `tests/native/ios-control.sh` for an actual
iOS Simulator UITextView linked to the generated bridge and Rust engine. Follow
[`tests/manual/ios-probe.md`](../../../../tests/manual/ios-probe.md) for the pinned
Xcode build/run, named assertions, composition policy, copy observations and
unqualified SDK/device/IME boundaries. The sibling macOS headless host remains
a separate prerequisite. No WebView or second writable document model is used.
