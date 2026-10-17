# Portable mobile harness

Run with the repository's pinned Node on rebuilt packages:

```sh
npm run build:wasm
npm run build
npm run test:mobile-web -- --group harness
```

`EDITAC_MOBILE_HARNESS_OUTPUT` selects an evidence directory; otherwise the dispatcher creates one in the system temporary directory. It retains TAP, exact package archives and hashes, browser/source pins, observations and teardown receipts. The dispatcher rejects unknown, unimplemented and empty groups, missing/stale/duplicate catalog IDs, zero tests and required failures/skips/cancellations. `all` does not silently omit unimplemented groups.

`case-index.json` freezes all 64 reviewed catalog rows, their original MWB owner and projected feature parent where one exists. MBC-08–12 belong to MWB-1.6/MWF-1.6. Registration is not execution. Mechanics/device receipt types and pending/deferred provenance are explicit; MBP performance and MBQ qualification retain their original owners. Update the index only against an adopted reviewed source, preserving its independent expected contract.

The harness reuses the RGS/INT `browserHarness` packing, process, receipt and teardown architecture. `fixtures/browser-mobile-web` mounts production `BrowserEditor` over the existing recovered local Session, Rust/WASM engine and real IndexedDB journal. The fixture never injects an expected committed result. Native DOM mutation and events model prepared platform delivery; all semantic/selection/effect/history expectations stay in the test process. The bounded initial profile is one unmarked paragraph, including backward and UTF-16 selections. Other structures belong to subsequent feature groups.

The host snapshot uses owning-window CSS coordinates, the actual scroll root, observed layout/visual geometry, requested meta-viewport mode and actual focus. It does not infer keyboard visibility. Prepared capability objects test detection, denied/throwing/absent/changing paths and native-contenteditable fallback without modifying browser API globals or prompting on mount. Actual browser capability observations are separate. Resource accounting measures listener/observer/timer/frame/capture deltas and requires disposal to restore the pre-mount baseline.

The mobile profile is desktop Chromium at 390×740 CSS pixels with touch emulation; geometry changes rotate those dimensions. It is prepared browser mechanics, never iOS/Android, native keyboard, API authorization, OS clipboard, AT, performance-budget or release evidence. All original mobile qualification gates stay open.

The `--group touch` profile implements MWF-1.2 portable MBT-01–07 and
SEL-06/SEL-07/XFR-07 coexistence. It uses the same production BrowserEditor,
recovered Session, WASM and IndexedDB fixture with optional existing reorder
controls. Native active pointer capture is real; touch/pen type and cancellation
traces are prepared and explicitly labeled. The long-document host fixture places
controls in a fixed panel and declares a scrollable editable region. A registered
inert atom, hard break and marked/empty text use existing fragment/engine paths.
The checks cover tracked and unrelated pointers, competing touch, exactly-once
moves, cancellation, bounded autoscroll, mixed input, tap/keyboard access and
resource disposal. Root defaults and native selection remain available. This is
portable mechanics evidence; native handles, menus, pinch behavior and target
platform/AT observations remain original MWB qualification work.

The `--group input` profile implements MWF-1.3 portable MBI-01–08 mechanics.
It reuses the same packed production editor, recovered Session, Rust/WASM and
IndexedDB for marked UTF-16 replacements, reported native deletion ranges,
composition ownership/interruption/conflicts and mixed keyboard input. Platform
composition/dictation/swipe/handwriting traces are prepared DOM/event delivery;
trusted desktop typing is a separate control. Automatic Markdown/slash routes
require qualified direct typing, with explicit commands available for literal
replacement input. Scoped pagehide uses the existing blur finalization policy;
this does not qualify actual BFCache, eviction, mobile IME or device support.
`BrowserEditor.inputRecovery` exposes bounded rejected/interrupted native/composition text
for host recovery separately from committed document content.
