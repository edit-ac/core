# Ordinary browser input fixture

WEB-1.4 mounts the production internal `TextInput` adapter on `DOMRenderer` and
`DOMSelection` after recovering a checkpoint into the real packed WASM engine
and attaching IndexedDB persistence. Each test owns its document, browser context
and storage; no provider or network service participates.

`npm run test:browser -- input` runs the 17 authored cases separately in pinned
Chromium, Firefox and WebKit. Facts retain native versus prepared event traces,
content/caret snapshots, intent dispositions, engine updates, semantic history,
durable journal entries, unrelated block/text identity, source/artifact hashes
and browser/server teardown. `EDITAC_INPUT_OUTPUT` selects a durable evidence
root with one subdirectory per engine.

Physical typing, forward/backward deletion, selected replacement/deletion and
empty-block reuse use browser keyboard actions. Emoji insertion is prepared
ordinary `insertText`, followed by native Backspace: Firefox's Playwright
`keyboard.insertText` uses composition and cannot qualify this ordinary route.
Duplicate notifications, repeats, observer ordering, renderer echoes, read-only
and disposal are explicitly prepared real-DOM replay.

WEB-1.5 reuses this packed engine/storage harness through
`npm run test:browser -- reconcile` and `EDITAC_RECONCILE_OUTPUT`. Its prepared
real-DOM replacements represent spellcheck, autocorrect and literal paste-like
mutations, with missing/noncancelable/unusable beforeinput, observer ordering,
duplicate notifications and deliberate repeated edits. Projection checks count
semantic BR line breaks rather than relying on textContent.

The sole TextInput observer invokes the bounded `reconcile.ts` reader: at most
64 mutation records, 2,048 visited nodes and 256 Ki UTF-16 text per affected block.
Single-block text changes produce one prepared Rust command. Unknown root or
multi-block structure, added markup, resource limits and changed baselines
produce rejected intents and bounded recovery text in `TextInput.recovery`.
Unknown scope and resource limits disable editing until host recovery/remount;
known rejected blocks are restored from authoritative projection. Renderer-owned
records are drained only inside its patch boundary. No whole-document HTML is
serialized or imported.

Remote composition, structural clipboard/keyboard commands and full editor
lifecycle retain later roadmap gates. These prepared mechanics do not establish
actual OS spellcheck/autocorrect, IME/device or release support.

WEB-1.6 reuses this fixture through production TextInput and CompositionInput.
`npm run test:browser -- composition` runs 38 authored cases per pinned engine;
`EDITAC_COMPOSITION_OUTPUT` selects the durable evidence root. Native DOM and
caret remain temporary while semantic selection mapping is suspended. The probe
never asks the stale renderer map to interpret intermediate composing DOM.

Each case initializes its baseline once per independent browser context and
captures block/text identity plus real engine/history/IndexedDB effects. Final
notifications, blur, cancellation, read-only and disposal retain explicit terminal
dispositions. Adopted Process/Dead owners release ordinary routing references at
finalization or read-only cancellation, so the next input without a keydown has
an independent owner. Duplicate final notifications cannot consume that edit.
All composition events are prepared replay; native ordinary keyboard actions in
history checks do not establish OS IME support.

WEB-1.7 uses `npm run test:browser -- composition-remote` with
`EDITAC_COMPOSITION_REMOTE_OUTPUT`. Prepared composition notifications and native
DOM mutations run through the production TextInput/CompositionInput owner. Peer
insertions and replacements come from a second real packed engine, then enter the
local replica through applyUpdate and its attached IndexedDB journal. The existing
Yjs deletion-probe tombstone models owner deletion through real update admission;
it does not add a public semantic delete API. Authored cases check retained
subtree/caret ownership, current peer projection, explicit overlap/stale-target
recovery text, terminal duplicates, directional replacements, UTF-16 positions,
independent patches, consecutive identical sessions and local-only undo/redo.
These prepared mechanics do not qualify OS IME or device support.
