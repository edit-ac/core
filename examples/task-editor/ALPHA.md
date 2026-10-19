# Internal local web alpha

This is the local web feature checkpoint (WFE-3.2). Run from `core/` with the
repository's Node 24.19.0, npm 11.17.0, Rust 1.97.1 and wasm-bindgen 0.2.129:

```sh
node examples/task-editor/product.mjs
```

Use the localhost URLs printed by this one launcher. It installs packed SDK
artifacts and uses a dynamic port. Stop with Ctrl+C; `preview.json` in the printed
artifact directory records the process, input pins and shutdown. To include the
opt-in Markdown parser, run the same command with `--markdown` and open its
`?markdown` link. The [walkthrough](README.md) documents package/site receipt
reuse and toolchain setup.

## Walk through the local product

1. Open Task/comment. Edit the rich task and plain comment independently; select
   task text, apply a rich command, then Undo/Redo. Save each document locally,
   reload and Reopen. Confirm each document retains its own text and formatting.
2. Open React tasks, edit and save, then follow Document body. Save distinct
   content there and navigate back, including browser Back. Route disposal and
   StrictMode use the public EditorHost lifecycle and matching local document.
3. Open the readonly URL or use Make task/comment readonly. Editing and rich
   commands must be denied while the existing content remains readable.
4. Follow the README's offline/recovery steps. Inspect the per-document recovery
   report and explicitly export retained bytes before leaving an unsaved editor.
   Export excludes sibling documents; it is a recovery artifact, not an import UI.
5. Open Local command assistance (`?assistance`), select task text and choose
   Bold/Italic/Undo/Redo through Editing assistance. This uses the same local
   command/history/save path and does not request microphone permission.
6. Open Local file controls (`?formats`). Prepare an import, inspect its preview,
   cancel once, then confirm and Undo/Redo. Save and reopen. Show installed format
   profiles and explicitly prepare/export a supported format. Readonly revocation
   prevents confirmation. File permissions/downloads remain explicit actions.

## Feature and limitation inventory

| Surface | Local alpha behavior and scope |
| --- | --- |
| Task/comment and React routes | Independent rich/plain editors, commands/history, route lifecycle, identity and readonly controls. |
| Local durability | IndexedDB save/reopen, offline shell, retained recovery bytes and honest save errors. Keep an unsaved live editor open after failure and export recovery before leaving. No remote durability claim. |
| Optional assistance | Local command discovery. Dictation requires a host transport and permission; the sample supplies neither a microphone transport nor AI providers. |
| Optional formats | Installed RTF, CSV/TSV, DOCX, ODT, EPUB profiles and export-only PDF, plus text/Markdown file controls. Table export needs an explicit table/dialect. Original-media import needs an authorized asset host absent from this sample. |
| Optional Markdown | Separate codec and explicit query opt-in; plain comments and disabled-parser input remain literal. |
| Other declared SDK features | The [feature ledger](FEATURES.md) maps rich extensions, touch/browser assistance, references, search/code, collaboration/presence and prepared AI APIs to their exact behavioral proofs. Host-configured peer sync/presence and AI are not enabled by the default local sample. |

The canonical acceptance command is
`node tests/scenarios/run.mjs web-product-checkpoint`. It runs the installed
SDK/WASM/IndexedDB workspace, React/routes, recovery, assistance and format
workflows in Chromium, Firefox and WebKit with independent semantic assertions.
Use `EDITAC_PRODUCT_PDF_PYTHON` with pypdf 6.1.1 and PyMuPDF 1.26.5 for the
independent PDF reader. A prepared build alone is not browser acceptance; consult
the resulting `receipt.json` and separate owner/main applicability receipt.

## Later-phase handoff

Native adapters and Windows/Linux follow the web boundary using the existing
semantic/storage owners. Public documentation polish, performance/size/resource
qualification, OS/IME/AT and device observations (roadmap43), native tests, beta
release and first external integrations retain their own unchecked predicates.
Cloud/document-store28 remains deferred. This internal checkpoint authorizes no
publication, deployment, provider calls or paid dogfood. Historical failures and
their original evidence remain preserved.
