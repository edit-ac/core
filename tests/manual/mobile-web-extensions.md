# Touch formatting and paste platform handoff

Owner: MTF-1.3, preserving MEX-1.9-I1/V1 and MWX-1.9. This runbook records no device execution. The automated portable proof uses packed production BrowserEditor, EditorSurface, shared Session/WASM and IndexedDB with deterministic clipboard transports. Desktop Chromium/Firefox/WebKit with a touch viewport is browser replay. It is neither an iPhone/iPad/Android runtime nor an actual OS clipboard/native menu observation.

## Artifact and environment record

For each observed row retain the exact core/web package archives and hashes, source/fixture hashes, served-body hashes, commit IDs, OS and browser builds, physical model or simulator/emulator image/version, input method, viewport/zoom/orientation, producer application and offered clipboard MIME flavors. Bind screenshots/recordings, before/after shared snapshots, journal/history counts and errors to that row. Record executed/passed/failed/skipped counts; leave an unavailable row pending. Never fill observations from desktop replay. Target-platform simulators/emulators are accepted under architecture/specs/verification.md; hardware-only substitutions require a documented tested equivalent.

## Required platform cells (all pending here)

| Runtime | Clipboard and selection | Status |
|---|---|---|
| Physical or simulated iPhone, iOS Safari | Native handles, OS long-press Paste menu, formatted/literal touch buttons | Pending, no observation |
| Physical or simulated iPad, iPadOS Safari | Same; split viewport, software keyboard; hardware pointer/keyboard only where claimed | Pending, no observation |
| Physical or emulated Android, Chrome | Native handles, OS Paste menu and clipboard suggestions, formatted/literal touch buttons | Pending, no observation |

## Formatting procedure — MWX-C05 / MWX-C10

1. Enable only the declared qualified extensions; seed mixed Unicode text, image/file captions, reference labels, extension text and registered file/image/math/inert carriers. Select a reverse range with native handles. Tap each labeled Bold, Italic, Underline, Strikethrough, Inline code and Edit link action. Apply a safe URL and remove it. Repeat with enabled atomic presenters, command search, keyboard visible/hidden, zoom and rotation. Record pointerdown/blur/activation, retained directional target and focus; unrelated source/opaque metadata stays exact. Each accepted change has one journal/history effect; undo and redo restore exact snapshots.
2. In a mixed table capture a reverse 2×2 rectangle. Tap Bold cells, Italic cells, Underline cells, Strike cells, Code cells, Link cells and Remove cell link. Repeat Paragraph cells, Heading 1–6 cells, Code block cells, Header cells, Body cells and Align cells none/left/center/right. Check selected cells, stable anchors, source, untouched cells and one history effect. Observe actual native handles separately from rectangle control replay.
3. Repeat read-only, protected cells, disabled/denied controls, missing/deleted target, canceled/no-op link, stale revision and a second editor. Rejection/cancellation must preserve document/history; never redirect to the newer selection/editor. Verify names, 44 CSS-pixel control targets, focus at zoom and native page/panel scrolling. IME/VoiceOver/TalkBack observations belong to the declared platform qualification and remain pending until executed.

## Clipboard procedure — MWX-C05 / MWX-C10 / MWX-C24

1. From a real producer copy supported internal structured content with competing HTML/plain flavors, then HTML, plain text, malformed internal data, unsupported rich data and disabled-codec/extension sources. At a captured reverse text selection tap Paste with formatting and Paste without formatting, including through command search. Record offered bytes/MIME and result; literal paste preserves exact text, rich paste honors internal precedence and admitted fallback. Retain unsupported source/recovery diagnostics. No undeclared codec is enabled.
2. Repeat using the actual OS long-press Paste menu. Record actual beforeinput/input/paste ordering, cancelability and target ranges. Test supported beforeinput-only and noncancelable replacement equivalents with a documented producer/runtime; do not label constructed ClipboardEvents as OS observations. Selection must survive menu focus, replacement must occur once with one undo/redo/history effect.
3. Paste a rich rectangle into selected table cells, literal tabs/newlines into one cell, and an incompatible literal rectangle. Preserve untouched cells and source; incompatible shape rejects atomically. Paste rich offers into block/inline code and confirm literal policy.
4. With an explicitly delayed prepared clipboard read, test cancel/dismiss, background, dispose, permission denial, empty offer, duplicate activation, stale/deleted target, another editor and later selection. No canceled/stale callback mutates or redirects. Later user selection survives a valid completion. Label these injected checks as prepared transport even on a mobile OS.

## Receipts and remaining owners

Run `npm run test:browser -- mobile-extension-formatting` with the pinned toolchain. Its receipt includes the complete 172-case portable registration in tests/browser/mobile-extensions/touch-predicates.json, reconciled against original catalog IDs. Missing/duplicate/unregistered/failed cases fail registration; test counts also include the registration assertion. Archives and served bodies authenticate the actual packed consumer; catalog-validator tests alone prove no runtime behavior.

Architecture evidence/mobile-extensions/touch-qualification-20261018/delivery.json records final portable evidence when available. Original native-menu/handle observations, full MWX-C05/C10/C24 platform predicates, MWX-C06/C08 scrolling/IME predicates, MWX-1.8 and roadmap43 remain open. Dictation, voice control, screen readers, timing/cost/budget and release are not qualified by this handoff. No publication, deployment, providers or credentials are required or authorized.
