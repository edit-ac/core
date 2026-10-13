# @edit-ac/web

Private development package for the edit.ac browser input, selection, clipboard,
local recovery, and incremental DOM adapter. Its API is under development.
Build from the repository root with `npm run build` before importing `dist/`.

```ts
import { mountEditor } from '@edit-ac/web';

// root, assetUrl, databaseName and identity are supplied by the host.

const editor = mountEditor(root, {
  assetUrl, databaseName, identity, indexedDB, locks: navigator.locks,
  label: 'Document editor',
});
await editor.ready;
const unsubscribe = editor.subscribe(state => {
  // ready and localCommitted represent different events.
});
await editor.flush({ target: 'local' });
unsubscribe();
await editor.destroy({ policy: 'flush' });
```

`flush({ target: 'local' })` waits for local journal commits; it does not report
remote settlement. Other flush targets reject. Commands reject while loading,
closing or read-only; recovery failures reject `ready` and remain observable in
state. `createEditor` returns the same lifecycle handle as `mountEditor`;
await `ready` before using it. `taskPreset()` supplies explicit Markdown paste
and typing-shortcut defaults. `chain()` collects commands for a single Rust
prepare/commit; `can()` validates them without mutation. `attachSync()` attaches
a host-supplied transport to the existing document and requires the peer identity
and authorization decision. Hosts drive its `receive()` and `pump()` methods;
attachment and sending frames do not establish durable remote settlement.

The host supplies an initialized document identity and local checkpoint through
the core/storage contracts. Mounting recovers that document before accepting
input. Existing preview DOM stays read-only and is replaced with authoritative
content and current selection mappings. Initialization failure exposes a readable
recovery view. A failed flush/destroy leaves `recoveryExport()` available; explicit
`destroy({ policy: 'report' })` returns the checkpoint and unsaved updates before
releasing resources. Repeated destruction is safe.

For an already initialized, host-owned engine, `mountEditorSurface(root, engine)`
mounts the same renderer, selection bridge and input adapters synchronously.
It exposes `settle()`, `setReadOnly()`, recovery records and `dispose()`. The host
retains the engine and disposes it after detaching the surface. Supply a `commit`
option to route prepared commands through host persistence; the default commits
to the engine only. The in-memory web examples use this public mount path.
Both mount paths reserve the root, including during asynchronous recovery.

The renderer preserves authored leading, trailing and repeated spaces on text
blocks, including headings and list items, without a host stylesheet. Prose uses
`white-space: break-spaces`; code blocks retain literal, unwrapped whitespace.
Hosts may style fonts and spacing while retaining these renderer-owned properties.
`npm run check:browser-baseline` builds the pinned WASM engine and packages, then runs the complete renderer,
keyboard and example suites in Chromium, Firefox and WebKit. It is part of the
workspace's `npm run check` gate.

Clipboard support includes versioned internal fragments, safe supported HTML,
native-menu and mobile input event routing, and literal paste. The optional
**Paste without formatting** button reads the script clipboard only on activation;
set `plainPasteControl: false` to supply your own labeled control. Hosts can call
`pastePlainText()` or `paste(data, { literal: true })` explicitly. Ctrl/Command+Shift+V
and macOS Command+Option+Shift+V request literal paste. It preserves destination
text style, including inline code, while bypassing incoming formatting and syntax
parsing. Denied script clipboard access leaves native paste available.

`clipboardCodecs` connects qualified format importers to the common prepared-edit
path. Full CommonMark/GFM, table/asset and other extension codecs have separate
roadmap gates; the minimal host does not claim that complete palette yet. Basic
platform-primary B/I/U and Shift+X formatting shortcuts use the semantic command
gate. Actual mobile OS clipboard, IME and screen-reader support requires device
qualification; deterministic browser replay is not device evidence.

Publishing is disabled until the implementation and release gates in
[edit-ac/architecture](https://github.com/edit-ac/architecture) pass.
License: Apache-2.0.

### Clipboard options

`mountEditor` and `mountEditorSurface` accept `preset: "task" | "minimal"`, `plainTextPolicy: "markdown" | "literal"`, `contentCodecs: {images?, tables?, callouts?, extensions?}` and `typingShortcuts`. The task preset parses plain-text Markdown; minimal keeps it literal. An explicit policy overrides the preset. Code contexts and explicit plain paste stay literal. Registered custom MIME codecs cannot override built-in flavors.

`editor.pasteDeferred(data)` captures the clipboard and stable target once and returns a job with `result`, `cancel()`, retained `source` and preparation/apply `timings`. Cancellation, disposal or a moved/deleted target leaves the source available for recovery. A later user selection is preserved when preparation completes. This API yields scheduling; it does not claim worker offload or physical-device qualification.

### Optional image and simple-table views

Pass `content: contentModules({ imageUrl })` to either mount API to render the
portable v1 image and table descriptors. `imageUrl` is a synchronous host asset
policy that receives URL, alt, title and original source metadata and returns an
absolute HTTP(S) URL or `null`. The presenter rejects credentials and unsafe
schemes; without this port it displays the alt/source without loading the authored
URL. Uploads and authentication belong to the host.

Tables keep a bounded rectangle and render simple marked runs with labeled native
cell controls. Tab moves between cells; native text selection and copy work within
a cell. Text changes commit through the configured engine/persistence port. Rust
checks the retained descriptor before changing a cell and its inert fallback in
one history group. Composition stays in the native control until completion;
stale edits preserve newer data. Read-only controls retain selection/copy.
Disabling `content` preserves descriptors and fallback text through recovery.
Merged cells, nested cell blocks, spreadsheets and upload controls are excluded.
