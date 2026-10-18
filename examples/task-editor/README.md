# Local task editor

Build with `npm run build:wasm` and `npm run build`, then run
`npm run example:task`. Open the printed localhost URL. Stop with Ctrl+C.
The example edits an isolated task description and plain comment, offers rich
task controls and literal comment input, saves locally and reopens the same
identities offline. Opening never seeds
over missing or corrupt existing content. Export recovery before closing after a
save failure; the JSON contains explicit byte arrays and is not an import format.

For an offline reload, use `/fixture/index.html` on the printed server and click
**Prepare offline reload** while online. Wait for the app-available message before
disconnecting. This explicitly caches only this app's code and WASM; task/comment
content remains in separate IndexedDB stores. Save each document locally, disconnect,
then reload or use its Reopen button. Clearing browser site data removes both stores
and the offline shell. The server can remain stopped while the prepared page reloads.

Status distinguishes pending changes, successful local saves and errors. Reopen first
flushes; a failed save leaves the live editor available for recovery rather than
opening an older copy. Export is a deliberate per-document download and includes
unsaved recovery retained after closing that editor. Keep that file before leaving
the page: retained reports are memory only. Recovery bytes are not an import UI.
**Make task/comment readonly** revokes editing for that identity, including subsequent
reopens in the same page; a fresh page uses the host's initial `?readonly` policy.
Storage denial, missing or corrupt checkpoints produce errors without reseeding or
claiming a saved receipt. The independent sibling remains usable.

The installed-SDK local recovery proof is
`node tests/scenarios/run.mjs web-local-recovery`; exact input hashes, offline/failure
screenshots and case receipts live under
`../architecture/evidence/browser-product-workflows-20261018/pwe-1.4/`.

For React 19.3.0, build the shipped client after the workspace build:

```sh
node_modules/.bin/esbuild examples/task-editor/react.mjs --bundle --format=esm --outfile=examples/task-editor/react-built.mjs
npm run example:task
```

Open `/fixture/react.html` on the printed server. The Task and comment link opens
two independent EditorHost surfaces in StrictMode; Document body opens a third
local identity. Route navigation flushes and disposes the previous surfaces before
mounting the next ones. Browser Back restores the matching route and saved content.
The task retains the original React sample's `example-react` storage namespace.
Save, recovery export and close controls act on their named document. Recovery
reports stay outside React components and remain available after route disposal.
No export includes a sibling document.

Use `?readonly` to inspect without editing. The default comment admits basic text
and history only; the task/document expose the existing rich presenters. The
`?profiles=equal` and `?order=comment-first` fixture switches exercise equal rich
profiles and reversed mounting without changing identities or granting permissions
to the default plain comment.

The preview uses workspace builds. The focused installed-tarball proof is:

```sh
node tests/scenarios/run.mjs web-react-routes
```

Select Node 24.19.0/npm 11.17.0/Rust 1.97.1 first. The proof installs actual local
core/web/React packages, uses React 19.3.0 and Chromium with real WASM/IndexedDB,
and saves exact source/package/graph hashes and screenshots under
`../architecture/evidence/browser-product-workflows-20261018/pwe-1.3/`.
It reuses the existing shared-resource graph/asset audits. These cases prove this
browser product integration, without qualifying the full platform/release matrix.

Local save does not confirm remote durability. `attachTaskSync()` in the plain
entry accepts a host-authorized transport; these examples contain no hosted sync,
authentication or uploads. Native/mobile input and performance remain unqualified.
Packages are private and unpublished. See [integration and recovery](../../docs/integration.md)
for asset hosting, statuses, cleanup and supported-format limitations.

Markdown is optional. Default Task mounts paste and type Markdown-looking text literally. To opt in, initialize `initMarkdown(parserAssetUrl)` from `@edit-ac/markdown`, then pass `markdown: markdownExtension(codec)` from `@edit-ac/markdown/web` to the same editor options (plain, React or Astro). The engine retains its single document owner. Direct engine consumers call `engine.registerMarkdown(codec)`; the returned registration can be disposed. Unavailable import/export throws `CapabilityUnavailable` / `markdown-codec-unavailable` without changing content; unavailable named Markdown clipboard sources retain diagnostics and exact recovery text.

The executable Task and React examples enable Markdown with `?markdown`; the Astro client uses the same explicit option and a separately hosted `/markdown.wasm`. Serve the optional package and parser only for enabled consumers. Cleanup detaches registration with the surface and preserves existing pending-save recovery.
