# Rendered web examples

Three editable documents using the actual Rust/WASM engine, DOM renderer, selection bridge and input adapter: project kickoff, bug report and meeting notes. This is an unreleased source preview of `@edit-ac/core` and `@edit-ac/web` **0.0.0**, not a public SDK installation example or platform qualification.

The page mounts through `mountEditorSurface` from `@edit-ac/web`, sharing adapter
setup, whitespace presentation, read-only behavior and teardown with the persistent
editor. The example owns its in-memory engine. The baseline browser gate tests
visible trailing spaces and heading-end Enter immediately before a list, including
subsequent typing and undo/redo.

From the core checkout with its pinned Node 24.19.0 and Rust toolchain:

```sh
npm run build:wasm
npm run build
npm run example:web
```

Open <http://127.0.0.1:4173>. `PORT=4174 npm run example:web` selects another port. Ctrl+C stops the static server. There is no backend, IndexedDB persistence, collaboration transport, credential loading or AI call. The browser runs one engine replica. Edits are cleared by reload, example switching or reset; export text first to keep a copy. Text export omits formatting and list markers.

Try ordinary typing, selection replacement, Enter, clipboard operations, keyboard formatting, undo/redo, read-only mode and resetting each sample. Unsupported edits expose recovery text to copy. Loading/action failures appear in the status line. Controls have keyboard focus states and labels; the editor has a multiline textbox role. The preview disposes input, selection, renderer subscriptions and the engine on page exit and example replacement.

`npm run test:example:web` runs deterministic browser checks against the source preview and closes its browser and temporary server. It does not qualify OS IME, mobile devices, release artifacts or all editor features. The docs examples gallery tracks release-backed consumers separately.
