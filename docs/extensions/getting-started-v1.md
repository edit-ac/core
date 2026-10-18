# Start with explicit extensions

The supported web facade is API version 1. Install compatible private tarballs of `@edit-ac/core` and `@edit-ac/web` (currently 0.0.0); publication remains gated. Import the editor and lightweight factories from `@edit-ac/web`. Select individual features; no preset or product use-case name is required. [This manifest](recipe-manifest.json) pins the exact sources shown below for downstream DOC-1.34/1.35.

`openLocal` opens an existing document using the host's typed `EditorOptions`: identity, databaseName, indexedDB, locks and assetUrl. The host creates/retrieves its checkpoint once; a beginner does not copy engine/codec/worker initialization into each extension. Local editing, history and persistence need no provider. The executable consumer uses a prepared local checkpoint; it never contacts a service.

<!-- recipe:getting-started -->
```ts
import { createEditor, DocumentSearch, Spelling, type EditorOptions } from '@edit-ac/web';

/** Recovery identifies an existing document; initialization belongs to its host. */
export async function openLocal(root: HTMLElement, recovery: EditorOptions) {
  const spelling = Spelling.configure({ mode: 'platform' });
  const editor = createEditor(root, { ...recovery,
    extensions: [DocumentSearch.configure(), ...spelling.extensions],
    platform: spelling.platform,
    formatting: { marks: { bold: { shortcuts: false, controls: false } } },
  });
  await editor.ready;
  return editor;
}
```
<!-- /recipe:getting-started -->

After readiness, Search is available and bold controls/shortcuts are explicitly disabled for this editor. Other core commands remain under the existing authority policy. Read `editor.extensionConfiguration` and `editor.extensionStatus` for admitted values and required versus lazy feature state. Await `editor.ready`; report rejection rather than treating attachment as saved. On host closure await `editor.destroy({ policy: 'flush' })` and inspect its result; flush failure must preserve recovery/unsent edits. A borrowed `mountEditorSurface` leaves engine/storage ownership with its host and uses `surface.dispose()`.

For more selections, see [configuration](configuration-v1.md): Images, Tables, MathNotation, References, SlashCommands, Markdown, Search and Reorder. Each `configure` value is immutable and instance-local. Do not serialize or spread a configured factory value: callbacks are intentionally held outside document data. Duplicate identities, dependencies/conflicts and invalid options reject before attachment. No failed optional feature can grant write authority.

Collaboration requires an explicit per-editor connector. Presence is a separate opt-in; a sibling collaborative editor does not add provider work to this local field. Default platform spelling preserves inherited/user settings and independently inherits autocorrection; unknown effective support stays unknown. [Custom spelling](recipes-v1.md#spelling) is explicitly selected, never a fallback. Code/Pairs facade admission and converters without qualified artifacts are not advertised here.

Continue with [authoring and API reference](api-v1.md), [recipes](recipes-v1.md), [migration](migration-v1.md) and [advanced hosting](hosting-v1.md).
