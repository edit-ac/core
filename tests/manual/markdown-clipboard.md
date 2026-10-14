# Roadmap 05 actual-device clipboard qualification

Qualification amendment (user decision, 2026-10-14): This protocol may run on physical devices, iOS/iPadOS Simulator, Android Emulator and desktop OS VMs/test hosts under `architecture/specs/verification.md`. Use actual target-runtime clipboard/menu/shortcut APIs and tested virtual equivalents for unavailable hardware-only cases. Missing physical hardware does not block FMT-1.15-V1; its full required profile/case matrix and current-artifact evidence still must pass. Preserve previous physical-availability receipts unchanged.

Status: READY FOR PLATFORM RUNTIME QUALIFICATION; required platform observations not fully executed. FMT-1.15-I1 authors this protocol. FMT-1.15-V1 remains unchecked until all required platforms have recorded observations. Prepared Playwright event variants are mechanical evidence only.

Use the exact compiled core/web packages and WASM pinned in `architecture/evidence/markdown/device/manifest.json`. Serve their unpacked `dist` folders as `/core/` and `/web/`, and the pinned `fixtures/browser-input/` files as `/fixture/`. Serve the prepared HTML producer separately. Use the device lab's HTTPS origin on physical phones (Web Locks/storage must be available); the test server's desktop loopback address is insufficient for remote phones. Record the origin and certificate setup. Do not alter SDK sources or silently use an installed product build. Record each server's launcher, PID, workspace, port, purpose and log; stop it after testing.

Initialize the fixture once per case from the browser/device inspector:

```js
await window.inputFixture.mount();
window.inputFixture.protocol.clipboard.plainTextPolicy = 'markdown';
window.inputFixture.protocol.clipboard.contentCodecs = {images:true,tables:true,callouts:true};
```

Inspect/export observations with `await window.inputFixture.state()` and retain the before/after records. Select content with actual native selection controls. Use real OS clipboard copy/paste for every entry-point case. Constructor-created ClipboardEvent/InputEvent or programmatic `paste()` does not qualify an entry point. Test setup and snapshot reading may use the inspector. Capture the first visible frame with video and a passive event trace (type, inputType, cancelable, isTrusted, MIME names; no synthetic dispatch). Preserve full source separately. Host option changes and delays must be recorded.

Fixtures: `device/palette.md` is the exact full Markdown palette; `device/html-producer.html` provides native rich HTML; `device/literal.txt` provides text that must remain literal. Their SHA-256 values and the automated palette's oracle are in the manifest/linked receipts. No provider calls or credentials are used.

| Required entry point | Actual platform and action |
|---|---|
| Native mobile paste menu | Physical or simulated iPhone Safari and physical or emulated Android Chrome; long-press selection, choose the native Paste menu. Record model, OS/build, browser/build and keyboard. Include physical or simulated iPad Safari if claiming iPad support. |
| macOS plain paste | Physical macOS host or macOS VM, claimed Chromium/Firefox/Safari versions; Command+Shift+V and Command+Option+Shift+V. Record OS shortcut remapping or interception as a failure/unsupported case. |
| Windows plain paste | Physical Windows host or Windows VM with each claimed Chromium/Firefox browser, Control+Shift+V. |
| Linux plain paste | Physical Linux host or Linux VM with each claimed Chromium/Firefox browser, Control+Shift+V; record desktop/window manager and clipboard manager. |

Execute the following cases on both required mobile platforms, and literal routing plus undo/redo on each required desktop shortcut/browser combination. A required platform that is unavailable keeps the gate open.

| Case | Native action and required observations |
|---|---|
| DEV-MD | Copy the full Markdown file in a real editor and paste from the menu with Markdown policy enabled. All admitted headings, marks, link, quote, nested list/check state, code language/whitespace, image/table descriptors appear in the first committed frame; exactly one clipboard document update, undo group and journal entry. Record producer MIME flavors; plain text Markdown is an admitted fallback. |
| DEV-HTML | Select/copy the producer's main content and paste from the menu. Admitted HTML marks, link, quote/list/code semantics survive. Repeat with real Word/Google Docs producers if claiming those producers; record exact application versions. Unsupported assets/formatting must retain source and diagnostics. |
| DEV-INTERNAL | Native copy from the edit-ac full palette and paste into a fresh target. If OS preserves the private MIME, it takes precedence and retains image/table tuples; otherwise record observed flavors and the admitted fallback. The fallback must not duplicate content or invent unsupported support. |
| DEV-LITERAL | Copy literal.txt and invoke each desktop plain shortcut. In mobile runs exercise the host's activated plain-paste command if supported. Exact Unicode/text/delimiters remain literal, with paragraph presentation and no inferred marks. One update/group/journal; record permission denial with zero effects and recoverable source. |
| DEV-PAIR | Observe native paste/beforeinput/input order (including noncancelable or quotation variants when the OS emits them). One semantic commit; no raw-text frame, duplicate insertion or clipboard deletion. Unsupported native variant is an explicit failure. Do not manufacture variants the platform did not emit. |
| DEV-HISTORY | Undo then redo each committed case. Undo restores the exact initiating content and preserves unrelated remote edits; redo restores imported semantics. No second paste update is emitted. Flush, reload offline and verify the stored projection. |
| DEV-PENDING | Use the public deferred-paste path with a recorded host scheduler delay and the real captured clipboard source. Cancel, move selection, remotely delete/move target, navigate/read-only and destroy in separate cases. Cancel/deleted/moved/disposed targets produce zero paste effects; later selection remains intact after success; recovery retains exact source. This observes the host job API separately from the native entry-point cases. |

A complete receipt includes: source and artifact hashes; fixture hashes; actual device/OS/browser/producer versions; input trace/video; exact before/after model, selection, history, update and journal observations; passed/failed/skipped/unavailable counts per case/platform; retained failures; and browser/server teardown. Store receipts under `architecture/evidence/markdown/device/observations/`. No required skip or zero observed case count can qualify FMT-1.15-V1.

Observation record template:

```text
Date/operator/device/model/OS build/browser build/producer build:
Manifest SHA-256/origin/server PID+port:
Entry point/case/observed MIME flavors/trusted event sequence:
Before/first-frame/after/history/journal/selection artifact paths:
Passed/failed/skipped/unavailable counts and reason:
Undo/redo/offline-reload results:
Failure/recovery artifact paths:
Browser/server teardown result:
```

Current availability is recorded in `session-20261013/apple-devices.log` (no devices) and `android-devices.log` (only an offline emulator). These are availability checks, not device test results. The device operator must supply the missing actual-platform observations; retry this gate when hardware or existing matching receipts become available.
