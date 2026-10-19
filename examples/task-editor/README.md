# Local task editor

Open the task workspace with `?assistance` to enable local command assistance.
Select task text, open **Editing assistance**, then choose Bold, Italic, Undo or
Redo. The panel uses the same command catalog, history and local save/reopen path
as the editor toolbar. Plain comments keep their existing restricted controls.
This option registers command discovery only; it does not configure a transcript
transport or request microphone access. Readonly mode disables its edit commands.

With the repository toolchains selected (Node 24.19.0, npm 11.17.0,
Rust 1.97.1, wasm-bindgen 0.2.129), run from `core/`:

```sh
node examples/task-editor/product.mjs
```

This single command builds a committed SDK snapshot, packs and installs the actual
local core/web/React/Markdown/format tarballs, bundles the existing React example with pinned
React 19.3.0, then prints localhost links for the task/comment workspace, React
workspace, document-body route and readonly view. It does not publish packages.
No mutable output from another checkout is linked. Product sources are copied and
hashed separately from the SDK snapshot. Use the dynamic port printed by the command;
there is no fixed port to reserve. Stop with Ctrl+C; the listener closes and
`.artifacts/browser-product-preview/<timestamp>/preview.json` records PID, port,
input hashes and shutdown. Build output stays there for inspection.

For an authenticated existing build, optionally set `EDITAC_PRODUCT_PACK_RECEIPT`
to an existing PWE receipt with core/web packs. Optional-format reuse also requires the exact Markdown and converter packs; all committed SDK build inputs must match. The launcher checks committed SDK
inputs, toolchain and every pack hash, then installs and bundles a fresh site.
`EDITAC_PRODUCT_SITE_RECEIPT` can instead select a prepared checkpoint's
`prepared.json`; all recorded source, package and served-file hashes are checked.
A prepared site is build evidence, never a passing browser result.

The internal [web feature ledger](FEATURES.md) maps public APIs to exact owner proofs and records remaining source/coverage gaps. It is maintained separately from the product checkpoint.

## Product walkthrough

1. Open the printed Task/comment URL. Edit task text; use Editing commands for
   bold/link, Slash commands for paragraphs, lists, checklist, table and local
   image, and References for the prepared local catalog. Edit the plain comment;
   rich actions remain absent. Undo in each editor and observe independent content.
2. Save both documents locally, then Reopen each. Reload to see the same identities.
   The status says **Saved locally** and explicitly does not confirm remote durability.
3. While online, click **Prepare offline reload**, wait for confirmation, then
   disconnect and reload. Both saved documents reopen. Offline shell preparation
   is deliberate; opening an uncached app offline is not supported. The prepared
   shell serves cached app code first. Click Prepare again online to refresh it;
   document bytes remain only in their independent IndexedDB stores.
4. Export recovery deliberately for the named document. On a real storage error,
   keep the unsaved live editor and export before leaving the page. Close/reopen
   first attempts a flush; failure does not replace live work with an older copy.
   Retained recovery after closing an editor is page memory. Downloads contain
   explicit byte arrays, exclude sibling content, and are not an import UI.
5. Reconnect, open React tasks, save task/comment changes, then follow Document body.
   Save its distinct content and use Task and comment or browser Back. The actual
   EditorHost runs in StrictMode; route disposal preserves the matching local document.
6. Open the readonly link, or revoke an editor's permission with **Make task/comment
   readonly**. Typing and rich commands are denied while valid local content remains.
   A fresh page uses the initial host `?readonly` policy.
7. Stop the launcher with Ctrl+C. Automated fault inputs for denied/corrupt/missing
   checkpoints and failed saves belong to the browser fixture, not a production
   fault switch exposed to users.

## Reproducible browser checkpoint

```sh
node tests/scenarios/run.mjs web-product-checkpoint
```

The canonical dispatcher installs once and runs the existing workspace, React/routes
and local-recovery workflows in Chromium, Firefox and WebKit. All three installed
Playwright runtimes are required. Unknown IDs, missing fixtures/commands, zero cases,
missing runtimes, failed cases or unexecuted required cases fail the checkpoint.
It records exact source/fixture/pack/site hashes, runtime versions, per-workflow
counts, screenshots, failure evidence and teardown under
`../architecture/evidence/browser-product-workflows-20261018/pwe-1.5/<timestamp>/`.
`receipt.json` is the outcome; `prepared.json` only authenticates build inputs.
Each browser executes real SDK/WASM/Session/IndexedDB. Earlier Chromium proofs
remain historical evidence; they do not replace these current profile runs.

This proves only the named browser product workflows when the receipt passes.
Original20's full mandatory-platform capability matrix, native desktop/mobile,
IME/composition, screen readers, physical-device qualification, collaboration/offline
reconnect with peers, AI/MCP, protected documents/encryption, performance/resource
budgets and editor-wide/release predicates remain open with their original owners.
Cloud-document storage is deferred. Optional Markdown and other optional unions
retain their separate gates. No remote durability, all-platform parity or release
readiness is established. Safe main landing and hash applicability require a
separate integration receipt; a queued request is not a merge qualification.

## Other existing entrypoints

The workspace-build preview remains `npm run build:wasm`, `npm run build`, then
`npm run example:task`. It serves local workspace outputs rather than the packed
checkpoint above.
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

Open the printed **Local file controls** link (`?formats`) to enable task-only
text/Markdown import and export plus the installed document converter profiles.
Select the intended task range, open **File and sharing**, choose a file and
review its preview before **Confirm import**. Import is one undoable editor
command; Save locally and Reopen retain it in IndexedDB. The plain comment keeps
its own controls and content. Opening the panel grants no file permission.

**Show installed format profiles** lists the pinned local package's RTF, CSV/TSV,
DOCX, ODT and EPUB directions and export-only PDF. Conversion loads on explicit
preparation. CSV/TSV export requires choosing one table and a dialect. Original
media import requires a separately authorized asset host, which this local
example does not configure; unavailable imports retain their original for recovery.
Cancel or readonly revocation prevents confirmation. Prepared output and original
file downloads remain explicit user actions; OS delivery is a separate claim.

Run `node tests/scenarios/run.mjs web-optional-formats` for the installed product
proof, or `web-product-checkpoint` for the combined three-engine checkpoint.
Set `EDITAC_PRODUCT_PDF_PYTHON` to a Python environment with pypdf 6.1.1 and
PyMuPDF 1.26.5 for the independent exported-PDF reader. ZIP/XML readers use the
Python standard library. The cases retain source/package pins and raw receipts.
