# Integrate edit.ac

The shared Rust/WASM engine owns the document. `@edit-ac/core` loads that engine;
`@edit-ac/web` mounts its browser surface and supplies local persistence, clipboard
and sync contracts. Optional `@edit-ac/react` and `@edit-ac/astro` bind the same
surface to framework lifecycles. Installing Astro does not require React.

These packages remain private, version 0.0.0, and unpublished. Use local tarballs
from this checkout. Registry installation, native adapters, device input parity
and performance/release qualification are still pending. Browser checks cover
pinned Playwright Chromium, Firefox and WebKit mechanics. They do not establish
physical Safari, mobile keyboards, IME or screen-reader support.

## Start with a runnable example

Use Node 24.19.0 and npm 11.17.0 from the repository pins. Build the artifacts:

```sh
npm ci --ignore-scripts
npm run build:wasm
npm run build
node --test tests/docs-examples.test.mjs
```

The last command packs the four SDK packages, installs them offline into temporary
consumers, builds the actual example sources and executes them in three browser
engines. It records tarball integrity, commands, browser versions and teardown in
`../evidence/sdk-docs/iteration3/`. It requires the pinned dependencies and browsers
to be installed; missing tools fail the check. It starts no persistent preview.

Choose a source entry:

| Integration | Executable entry | Qualified candidate |
| --- | --- | --- |
| Plain browser | [Task editor](../examples/task-editor/index.html), [client](../examples/task-editor/editor.mjs) | Native ESM and explicit WASM URL |
| React | [React task](../examples/task-editor/react.html), [client](../examples/task-editor/react.mjs) | React / React DOM 19.3.0; peer 19.3.x |
| Astro | [Astro task](../examples/astro/src/pages/index.astro), [client](../examples/astro/src/client.js) | Astro 7.3.8; peer 7.3.x; Node adapter 11.1.7 |

[Plain/React hosting instructions](../examples/task-editor/README.md) and
[Astro static/SSR instructions](../examples/astro/README.md) describe local previews.
Every entry uses the common editor surface. Keep package imports unchanged when
copying these examples to an application; install the packed SDKs into that
application rather than adding aliases to workspace TypeScript sources.

## Creation, loading and asset hosting

Creation is an explicit application action. The examples create a v5 engine with
a fresh document ID and epoch, then publish its checkpoint to IndexedDB. Opening
an existing identity recovers its checkpoint and journal. A missing or corrupt
checkpoint fails visibly; opening must never seed a replacement document over it.
The plain example stores creation intent before saving the initial checkpoint so
that a failed first save cannot silently replace the document on reload.

`createEditor(root, options)` returns a lifecycle handle immediately. Await
`editor.ready` before commands, selection, paste or saving. Provide a stable
identity, databaseName, explicit assetUrl, IndexedDB and Web Locks. Use HTTPS or
localhost and preserve the database and identity together. A storage error or
unavailable browser port must remain visible to the user.

Serve the complete packed core `dist/wasm` directory, including JS glue, beside
the compiled loader's expected asset paths. Serve WASM with `application/wasm`.
The plain example's import map maps `@edit-ac/core` to `/core/index.js` and
`@edit-ac/web` to `/web/index.js`; its asset URL is
`/core/wasm/editac_wasm_bg.wasm`. The bundled React entry also needs the `wasm/`
glue directory beside its bundle. Astro emits JS glue through Vite and hosts the
binary at `/engine.wasm`. Copy the binary from the installed tarball, never from a
second runtime package. Use one installed core owner for all bindings.

For CDN hosting, allow the asset origin in CORS, `script-src` and `connect-src`.
WASM compilation needs CSP `wasm-unsafe-eval`; the qualified native ESM consumer
does not require JavaScript `unsafe-eval`. Authorize import maps and module scripts
with your CSP policy. The example's inline style needs its own style policy;
move it into an allowed stylesheet when deploying. The packed consumer check
qualifies explicit asset URLs and CSP/CORS loading; it does not qualify your host.

## Editing and literal paste

`taskPreset()` enables Markdown plain-text paste and typing shortcuts.
`plainTextPolicy: 'literal'` selects literal paste by default. Explicit
`editor.paste(data, { literal: true })` and `editor.pastePlainText()` keep source
characters without incoming formatting or Markdown parsing. Native paste remains
available if script clipboard permission is denied. The surface includes a labeled
Paste without formatting control unless `plainPasteControl: false` is supplied.

`chain()` collects commands for one Rust prepare/commit. Its `can()` validates
without mutation; `run()` commits the validated batch atomically. Public offsets
are UTF-16. Release caller-owned anchors/caret tokens after use. Subscribe to a
specific patch scope when you need document changes; use the status subscription
for loading/saving indicators and dispose every subscription with its host.

## Saving, sync and recovery

`editor.state.ready` means input is available. `localCommitted` represents a local
journal transaction, not remote durability. `flush({ target: 'local' })` waits for
local writes; other targets reject. Display local and remote states separately.
The examples say “Saved locally. Remote durability is not confirmed.”

`attachSync()` uses the existing document. The host supplies an authorized
transport, matching peer identity and its authorization decision, then routes
frames to `receive()` and drives `pump(now)`. Detach before replacing a transport.
Handshake completion, frame transmission and an acknowledgement are not a
`remoteSettled` receipt. Display remote settlement only when the host validates
the required durable receipt; these examples have no hosted backend.

The host owns authentication, authorization, token refresh and uploads. Keep
secrets on your server. Optional image presentation requires an explicit safe
`imageUrl` policy; descriptors do not grant upload or network permission.

Await `destroy({ policy: 'flush' })` before discarding a plain host. If a save fails,
keep the live editor and its `recoveryExport()`, or explicitly request
`destroy({ policy: 'report' })` and retain the returned `unsaved` recovery report.
The examples offer Export recovery, which downloads byte arrays in a documented
JSON byte representation. This file is recovery evidence for the host, not a
supported content import/migration format. Keep the original until a separately
qualified recovery process confirms restoration. Ordinary reload demonstrates
successful local checkpoint/journal recovery, not failed-save restoration.

Full page exit cannot guarantee an async flush. Save during normal editing and
retain reports outside a component's lifetime. Do not erase local storage to
“fix” an opening failure. The examples expose failures and preserve the identity.

## React lifecycle

React renders an empty `EditorHost`; the editor owns its editable DOM and document.
Build browser options in the client entry and keep them stable. Replacing options
requests teardown and a new session. Use `onReady` to obtain the imperative handle,
`readOnly` to change authority, and `onError`/`onDispose` to retain failed-save
reports outside component state. `useEditorState` may drive a separate toolbar;
never render the document through React on every keystroke.

Server import and empty-host render are safe; the browser entry itself is client
only. StrictMode repeats setup/cleanup in development, so the binding serializes
same-host and same-document teardown. React unmount is synchronous; `onDispose`
can arrive later after local flush. See [React StrictMode](https://react.dev/reference/react/StrictMode).

## Astro static, SSR and navigation

Import `Editor` from `@edit-ac/astro/Editor.astro` in the server page and call
`installEditorHosts(document, asyncResolver, events)` in a processed browser script.
The server renders an empty host and does not load WASM or touch browser globals.
The resolver opens one identity per named host after loading asynchronously. Static
and standalone SSR use the same client bridge. Set `readOnly` on the notes host to
retain selection/copy while disabling edits.

Use Astro's `ClientRouter` for navigation. The binding waits for flush/disposal in
the preparation loader before the page swap, then remounts using the persisted
identity. On failure, `onError` and `onDispose` expose the unsaved report before
navigation continues. The example retains those reports in module memory across
ClientRouter navigation and restores visible recovery controls on return. Export
before closing the tab. Its async cleanup function is available for applications
that remove the installation explicitly. See [Astro view transitions and lifecycle](https://docs.astro.build/en/guides/view-transitions/).

Future framework bindings must reuse these document, loading, authority and
cleanup contracts. Additional framework support requires its own pinned lifecycle,
packed-consumer and executable-example qualification.

## Supported content and remaining limits

The task preset covers the implemented Markdown editing subset: paragraphs,
headings, lists, quotes, fenced code and common inline marks. Safe clipboard HTML
is constrained to supported structures. Rich-format fidelity beyond that subset
is not promised. Optional image, simple-table, math, reference and slash presenters
need explicit modules and host policy; these examples do not enable them.

Simple-table views exclude merged cells, nested cell blocks and spreadsheets.
Uploads, arbitrary HTML execution, full office-format fidelity and PDF import are
unsupported here. User-content/editor migration features are deferred until the
application is completed and qualified. No native UI, Swift/Kotlin adapter, mobile
keyboard parity, performance budget or registry release is established by this guide.
