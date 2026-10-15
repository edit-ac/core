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

### Change review

`ChangeReview` is an optional presenter for the diff companion's `editac-exact-patch-v1` wire and `editac-semantic-diff-v1` JSON. It renders unified, inline and side-by-side views with native keyboard controls, explicit representation labels and paged difference rows. Projected Markdown requires a serializer and dialect label; semantic facets preserve moves alongside content, formatting, links and opaque data. Attribution remains unknown/unverified.

```js
import { ChangeReview } from '@edit-ac/web';
const view = new ChangeReview(container, {
  representation: 'exact-source', wire: encodedPatch,
}, { mode: 'readonly', layout: 'side-by-side' });
// Later, replace the immutable review input or dispose the owned DOM.
view.update(nextReviewInput);
view.destroy();
```

Modes are `readonly` (the default), `history`, and `writable`. Only writable source/projected views with an `onAccept` callback expose hunk selection and acceptance. The callback receives representation, before/after hashes and ordered zero-based hunk indexes. The host must prepare/apply through the session's revision-checked review service; the presenter never applies edits or rewinds a replica. A changed revision/profile or hunk mapping clears selection; display controls and pagination preserve it.

Default admitted input is 2 MiB, pages contain at most 100 difference rows, and displayed values/labels are clipped at 4,096 UTF-16 units with an explicit notice. Host limits have hard ceilings of 16 MiB input, 200 rows/page and 16,384 UTF-16 units/value. Pagination retains all admitted rows; clipping never claims that the displayed value is complete. Inputs are copied on explicit construction/update, outside typing. Content is rendered as inert text. Dispose removes only the presenter's owned region.

### Historical inspection and restoration

`WebHistoryStore` is an optional, host-owned memory store for explicit named semantic captures. It bounds revision count and encoded bytes; history is not captured on each edit. `read(handle, access)` returns an immutable available revision or an explicit missing, pruned, incompatible or key-unavailable result. The host supplies the complete identity/module scope, access policy and any authenticated provenance. Labels alone never prove authorship. The store is decrypted memory, not an encrypted archive; recreate it only with an explicit host archival policy.

```ts
import { WebHistoryStore, HistoryRestorer, HistoryReview } from '@edit-ac/web';

const store = new WebHistoryStore({ maxRevisions: 32 });
const access = () => ({ scope: { identity: engine.read().identity, moduleProfile } });
const revision = await store.capture(engine, access(), 'Before revision', { origin: 'unknown' });
const restorer = new HistoryRestorer(store, {
  engine,
  writable: () => hostWritable,
  // Route the opaque Rust plan through ordinary storage/policy admission.
  commit: plan => storage.commitPrepared(plan),
}, access);
const history = new HistoryReview(container, store, access, { restorer });
history.inspect(revision); // Reads an immutable projection; never checks out a replica.
// Call refresh() after new captures; destroy() removes the owned controller/DOM.
```

Historical inspection has no mutation controls. A separate writable section previews and applies restoration as a new semantic edit. The preview is single-use and bound to the current engine state; a peer edit, deletion, unavailable revision or changed policy yields visible conflict/recovery. The initial adapter restores same-identity, same-structure unmarked text through existing Rust commands. It retains unchanged marks/opaque nodes and rejects unsupported structural or mark changes without normalization or document reimport. Accepted restores retain node/source identities, use an isolated undo group and generate ordinary local journal updates. Flush through the storage lifecycle before claiming local durability. The view labels semantic projections and unknown attribution explicitly, paginates revision lists and clips values with a notice. It does not retain or claim original source spelling, global revision order, per-character authorship or durable archival history.

## Public module entry point

`@edit-ac/web/modules` exposes the v1 portable registry/command/codec types from
`@edit-ac/core/extensions` and the existing browser `ModuleRuntime`, renderer,
slash, reference, reorder and content presenter contracts. Root `@edit-ac/web`
registry imports stay compatible and share the identical core registry class.
Renderer functions remain host objects; descriptors accept inert data only.
Importing these entry points does not mount views, initialize WASM or fetch data.
Heavy math rendering stays separately opt-in through `@edit-ac/web/math`.
See the core package's public extension contract v1 for registration, frozen
registries, supported data versions and limits on custom editing semantics.

## Private reference display

`privateReferenceDisplay(options)` is an optional `ContentFactory` for existing
`referenceBlock` atoms. Pass it as `mountEditorSurface(..., {content: factory})`, or
compose it with other factories using `references(context) ?? other(context)`.
It preserves the shared target and authored label; fetched titles, previews and
icons exist only in the current viewer's DOM. Rendering, replay and remote edits
read the synchronous `cached(request)` port and never start a lookup. Only the
Refresh reference button calls `ports.privateCatalog(request, signal)`.

The host supplies current `context()`, a configured-catalog `target(targetId)`
projection, and `subscribe(invalidate)` with an unsubscribe function. Notify on
logout, account/tenant/authority switches, permission/policy revisions, revocation
and key lock. The cache must scope records by principal, tenant, authority, target
and policy/permission revision and return a `LinkResult` using the supplied request
envelope. The presenter revalidates that envelope and its capabilities and lease
before displaying fields and after host asset callbacks. Offline display expires
at the recorded lease; it cannot detect an unreported remote revocation instantly.

`iconAsset(handle)` may return vetted raster bytes as a Blob (PNG/JPEG/GIF/WebP,
maximum 32 KiB). No URL supplied by metadata becomes a browser request. The view
revokes object URLs when hidden, updated or disposed. Forbidden and missing states
share an accessible neutral fallback; readonly still permits explicit lookup.
Refresh has a 10-second timeout. Disposal unsubscribes and aborts work; late replies
cannot restore display. Hosts retain all credentials and connection admission.
This presenter does not publish private metadata or implement target activation.
