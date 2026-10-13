# Local task editor

Build with `npm run build:wasm` and `npm run build`, then run
`npm run example:task`. Open the printed localhost URL. Stop with Ctrl+C.
The example edits one persisted document, parses task Markdown, offers literal
paste, saves locally and reopens the same identity offline. Opening never seeds
over missing or corrupt existing content. Export recovery before closing after a
save failure; the JSON contains explicit byte arrays and is not an import format.

For React 19.3.0, build the shipped client and copy its glue assets:

```sh
node_modules/.bin/esbuild examples/task-editor/react.mjs --bundle --format=esm --outfile=examples/task-editor/react-built.mjs
mkdir -p examples/task-editor/wasm
cp -R packages/core/dist/wasm/. examples/task-editor/wasm/
npm run example:task
```

Open `/fixture/react.html` on the printed server. React renders an empty host;
local checkpoint creation runs in the client entry. Its StrictMode lifecycle
flushes on unmount and retains failed-save reports outside the component. The
preview uses workspace builds; `node --test tests/docs-examples.test.mjs` separately
installs local tarballs and builds/runs these same sources in isolation.

Local save does not confirm remote durability. `attachTaskSync()` in the plain
entry accepts a host-authorized transport; these examples contain no hosted sync,
authentication or uploads. Native/mobile input and performance remain unqualified.
Packages are private and unpublished. See [integration and recovery](../../docs/integration.md)
for asset hosting, statuses, cleanup and supported-format limitations.

Markdown is optional. Default Task mounts paste and type Markdown-looking text literally. To opt in, initialize `initMarkdown(parserAssetUrl)` from `@edit-ac/markdown`, then pass `markdown: markdownExtension(codec)` from `@edit-ac/markdown/web` to the same editor options (plain, React or Astro). The engine retains its single document owner. Direct engine consumers call `engine.registerMarkdown(codec)`; the returned registration can be disposed. Unavailable import/export throws `CapabilityUnavailable` / `markdown-codec-unavailable` without changing content; unavailable named Markdown clipboard sources retain diagnostics and exact recovery text.

The executable Task and React examples enable Markdown with `?markdown`; the Astro client uses the same explicit option and a separately hosted `/markdown.wasm`. Serve the optional package and parser only for enabled consumers. Cleanup detaches registration with the surface and preserves existing pending-save recovery.
