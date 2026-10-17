# Link an issue code after a delimiter

Copy [task-links.ts](task-links.ts) into your application. It has one public
`@edit-ac/web` import and uses the existing `Extension.create`/`context.match`
API. Compile it with your application's TypeScript configuration. No private
imports, task service, credentials or new engine schema are required.

```ts
import { createEditor } from '@edit-ac/web';
import { createTaskLinks, preparedTaskResolver } from './task-links.js';

const TaskLinks = createTaskLinks({
  permission: () => ({ principal: 'demo', tenant: 'prepared', authority: 'tasks',
    revision: 'catalog-1', lookup: true, apply: true }),
  resolve: preparedTaskResolver,
  onStatus: status => { statusElement.textContent = status; },
});
const editor = createEditor(root, { ...localStorageOptions,
  extensions: [TaskLinks.configure({ paste: false, timeoutMs: 5000 })],
});
await editor.ready;
// On teardown: await editor.destroy({ policy: 'report' });
```

Here `root` is the editor's element, `statusElement` is an optional separate
`<p role="status">`, and `localStorageOptions` is your normal local document
identity/database/asset configuration. The fixture test below creates these
with real IndexedDB storage and the production WASM engine. No preset is needed.
Use the same configuration in `mountEditorSurface` when the host owns the engine.

Type `ASD-123` followed by a space. While pending the source remains literal.
The fixed catalog returns `https://tasks.example.test/issues/design-123`, and
one standard link mark covers exactly `ASD-123`. The destination is explicit
catalog data; it is never assembled from the code. `DOC-7` is the second fixture;
`ASD-999` is missing and stays literal. The `.test` URLs are prepared examples,
not a production integration. There is no startup lookup or content upload.

Keys use 2–8 ASCII capitals and 1–6 digits. A space, tab, newline, `. , ; ! ? ) ]`
must follow the code. Letters, Unicode letters/digits, `_` and `-` cannot directly
precede it. End-of-input alone does not trigger. Paste is ignored by default;
`paste: true` explicitly enables the same bounded grammar for committed paste.
The runtime excludes code blocks, code/link runs, admitted extension data,
composition and remote/replay/format-only changes. A host may supply `literal`
to bypass its literal input origins. These policies do not rescan on reopen,
copy/export or undo/redo. Very fragmented or oversized context fails closed.

The matcher captures stable engine anchors before awaiting. Editing/deleting the
code, readonly, undo, disposal, changed policy or a manual link rejects stale
results. Unrelated edits can rebase a valid target. One successful application
preserves source, adjacent formatting and selection, converges through existing
peer updates and adds one shared history action. Undo removes the generated link
without removing the code; redo restores it. Neither starts a fresh lookup.

`onStatus` receives only sanitized transient states, including `pending`,
`applied`, `missing`, `forbidden`, `unavailable`, `failed`, `deadline`, `invalid`,
`cancelled` and `stale`. Render these outside the document. Denial, not-found,
errors, timeouts and unsafe destinations make no document/history change and
never fall back to a public fetch. Host callbacks are trusted code; AbortSignal
does not preempt an uncooperative promise. This recipe bounds concurrent work to
two requests, eight queued/matched items and eight principal-scoped cache entries.

For a real host, replace only `permission`/`resolve`, honor the supplied signal,
and keep authorization/credentials outside document data and status messages.
Supply `subscribe(invalidate)` to cancel and clear intent/cache synchronously on
logout, permission, principal or catalog changes; return an unsubscribe function.
Change `permission().revision` with the policy/catalog too. Replacing the editor
configuration uses disposal and a fresh attachment. The optional `attached`
callback exposes the managed controller for host diagnostics or explicit
invalidation; do not dispose it while expecting the same attachment to keep working.
All subscriptions and pending targets are released on editor disposal.

This example uses ordinary link marks. A persistent task identity is a distinct
optional data-defined reference, with a declared schema, admitted codec and
presenter/fallback policy; see the public authoring example. It must be selected
explicitly and does not follow from linking a code. New editing semantics require
the engine owner; do not replace document state, history or dispatch in a recipe.

Run `node scripts/test-extension-dx.mjs --group task-links` with the repository's
pinned toolchain. The fail-closed group compiles this exact downloadable source
against installed tarballs, then exercises Chromium, Firefox and WebKit with real
BrowserEditor/Session/WASM/IndexedDB/history/peer paths and prepared responses.
Typed keyboard input is real browser input; prepared clipboard/composition and
fixture services do not qualify OS/device/IME/AT, provider quality or performance.
