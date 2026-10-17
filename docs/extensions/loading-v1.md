# Optional code and assets

The web package owns lightweight configuration factories and view lifetimes.
`@edit-ac/core` owns the existing engine, Yrs/update and local storage boundary.
Selecting no optional feature still includes those baseline costs. Package
archive sizes are not browser bundle or performance qualification.

Collaboration orchestration, attachment and presence use separate asynchronous
entries. A local editor starts no connector and waits for no provider. Legacy
`attachSync` uses the same deferred attachment over the same replica. After each
asynchronous import, the editor rechecks its generation and lifetime before
calling the host or attaching resources. Presence remains an independent opt-in.
Code imports can be shared; connections, authority, subscriptions and history
remain scoped to their editor. Sync and presence are host-pumped, without an
SDK retry timer.

`MathNotation` keeps only its admitted data definition and a small view adapter
in the facade. Its renderer and KaTeX load on the first math presentation. The
canonical LaTeX source remains visible on failure. MathML uses the existing
bounded renderer without remote fonts, trusted HTML or user macro state.

`Markdown` remains in the optional `@edit-ac/markdown` package. A disabled
consumer can bundle the web facade without installing Markdown. A selected
consumer must supply that package's dedicated web entry through an import map
or the host manifest below. A bundler cannot discover an arbitrary uninstalled
package. Keep the Markdown entry independent when building the enabled consumer;
the canonical recipe is `tests/extension-dx/loading-consumer.mjs`. It packs and
installs actual packages, emits separate ESM entries/chunks, and retains both
the emitted graph and every asset hash.

Direct browsers map `@edit-ac/markdown/web` to the installed package's
`dist/web.js`; its default WASM URL is relative to that entry. The ordinary
factory does not initialize the codec at import time. `Markdown.configure()`
gates required input readiness. `Markdown.configure({ input: false })` leaves
typing ready and literal until the first explicit `exportMarkdown` call.
Parser failure retains source, rejects the original readiness promise and
reports a retryable feature status. After repairing asset delivery, explicitly
call `loadExtension('editac.markdown')` to resume the same replica. There are
at most three attachment attempts, including the first. After that, repair the
host and remount. A browser may cache a failed ESM module import; that failure
can require a new compatible versioned module URL and remount. Disposing one
pending attachment does not cancel compatible initialization used by a sibling.

## One advanced host manifest

Use immutable deployment paths for a compatible release. Resolve these paths
against the authorized host origin before passing configuration:

```ts
const assets = { manifest: {
  engine: new URL('/assets/v1/core/editac_wasm_bg.wasm', location.href).href,
  markdownModule: new URL('/assets/v1/markdown/web.js', location.href).href,
  markdown: new URL('/assets/v1/markdown/wasm/editac_markdown_wasm_bg.wasm', location.href).href,
  mathModule: new URL('/assets/v1/web/modules/math.js', location.href).href,
  highlightWorker: new URL('/assets/v1/web/modules/code/worker-entry.js', location.href).href,
  highlightBackend: new URL('/assets/v1/web/modules/code/backend/editac_highlighting.js', location.href).href,
} };
```

Pass `assets` once with the editor options. Preserve each entry's relative
module/WASM subtree, or emit a dedicated bundled entry and put its generated URL
in the manifest. The installed bundler recipe emits Markdown separately and
uses its generated URL. A `baseURL` remains the compact alternative for a host
that supplies the conventional `editac_wasm_bg.wasm`,
`editac_markdown_wasm_bg.wasm`, `markdown.js`, `math.js`,
`highlight-worker.js` and `editac_highlighting.js` names and their relative
dependencies. The manifest avoids flattening unrelated module trees.

Serve JavaScript as a JavaScript MIME type and WASM as `application/wasm`.
CSP must authorize the selected script/worker origins and WASM execution;
cross-origin modules/assets require appropriate CORS headers. A missing module,
incorrect MIME, denied CSP or denied CORS produces the feature's explicit
failure/source-preserved outcome. The SDK does not fetch public substitutes.

## Advanced highlighting port

The existing code highlighting implementation has a lightweight managed loader:

```ts
import { managedCodeHighlighting, mountEditorSurface } from '@edit-ac/web';

const surface = mountEditorSurface(root, engine, {
  codeHighlight: managedCodeHighlighting({ assets }),
});
```

This is the existing legacy presentation port; keep legacy assembly separate
from the admitted `extensions` facade. The Code and Pairs facade catalog entries
remain unqualified. This loader starts on a code block, retains only current
pending block presentations, uses the qualified independent worker/backend,
and releases workers, CSS ranges and styles on disposal. `enabled: false`
loads no highlighting implementation. A host wrapping the returned factory can
observe its `status` and explicitly `load()` again after an import failure,
within the same three-attempt limit. The focused subpath
`@edit-ac/web/highlighting` exports the same loader and types. Default worker
URLs work in the installed native ESM layout; bundled hosts use the single
generated manifest. Browsers without CSS Highlight support retain plain source
and report the existing `unsupported-browser` state without starting a backend.

PDF export and DOCX directional facade/worker entries are unavailable in this
browser delivery. Their runtime cells remain owned by qualified CNV artifacts;
existing native exports and WASM test compilation do not establish a browser
worker. PDF is export-only, and its import remains forbidden by the conversion
contract. No generic parser,
automatic upload, public-fetch fallback or new document/history owner is added.

`node scripts/test-extension-dx.mjs --group loading` executes the installed
direct-browser and bundled consumers in Chromium, Firefox and WebKit. Retained
artifacts include emitted/native graphs, exact code/asset identities, real eager
and duplicate-engine controls, prepared transport and hosting failures,
current/stale attachment cases, source/history preservation and teardown. These
checks establish portable loading behavior, not OS spelling, device, release,
performance budgets or provider quality.
