# Parse a bounded note clipboard format

Copy [parsing.ts](parsing.ts). It imports only `@edit-ac/web`; `Notes.configure()`
is the single extension configuration. The codec returns a fragment through
`Extension.create({ clipboardCodecs })`. The production clipboard owner validates
it with the unchanged engine before committing one prepared paste.

```ts
import { createEditor } from '@edit-ac/web';
import { Notes, NOTE_MIME } from './parsing.js';
const editor = createEditor(root, { ...localStorageOptions,
  extensions: [Notes.configure()],
});
await editor.ready;
const raw = 'note/1\np:First\nh2:Title\nb:Strong';
editor.paste({ getData: type => type === NOTE_MIME || type === 'text/plain' ? raw : '' });
// First (paragraph), Title (heading 2), Strong (bold paragraph).
// One shared undo restores the previous selection/content. Redo restores all blocks.
// On teardown: await editor.destroy({ policy: 'report' });
```

`root` and `localStorageOptions` are the host element and local persistence/identity
configuration from the editor getting-started guide. No provider is required.

The exact grammar is `note/1` then one to eight LF-separated lines of `p:TEXT`,
`h2:TEXT` or `b:TEXT`. Text is nonempty, at most 128 UTF-16 code units and contains
no C0/C1 controls; the complete source is at most 2,048 UTF-8 bytes. There are no
escapes, nesting, links or embedded code. Unicode and markup-looking text are
literal field values. Every line must validate; partial conversion is forbidden.
Errors are stable `note-size`, `note-version`, `note-lines` or `note-line` codes.

Only `application/x-example-note` selects this parser. Plain text is literal.
The existing clipboard precedence remains authoritative: valid internal fragment,
registered structured-extension transfer, Markdown/HTML, registered custom MIME,
then plain text. Among custom MIME codecs, configuration order wins. Malformed
internal flavors may fall through with diagnostics; an invalid registered
structured-extension transfer is authoritative and does not flatten silently.
`editor.paste(data, { literal: true })` bypasses all rich formats; Shift+primary+V
and `pastePlainText` are accessible literal routes. Code destinations stay literal.

A rejected custom format retains the exact MIME/source/reason in
`editor.clipboardRecovery` (bounded by the clipboard owner's four-record/1 MiB
limits), then tries the declared plain fallback. With no fallback it rejects and
leaves content/history unchanged. The host must offer recovery from these records;
a successful literal fallback is **not** successful conversion. Larger than 1 MiB
sources exceed the owner's capture limit and must be retained by the host itself.
Never insert raw source first and reformat later.

`editor.pasteDeferred(data, { schedule })` captures flavors and stable anchors
before scheduling. `job.cancel()` and editor disposal prevent application; the job
retains `source`. Reparented/deleted owners reject with recoverable source; unrelated
text edits can rebase stable anchors. This scheduling seam is not worker offload.

Use a clipboard codec for a declared interchange format; use an input rule for a
small synchronous typing gesture and a managed matcher for asynchronous host
resolution. Neither is a general parser. Persistent custom references require an
admitted data definition/codec and source fallback; transient behavior needs none.
This recipe adds no schema or engine semantics and executes no document content.

`node scripts/test-extension-dx.mjs --group parsing` compiles this exact source
against installed public tarballs and runs the production BrowserEditor/Session/
WASM/IndexedDB/clipboard/history stack in Chromium, Firefox and WebKit. FMT
precedence, recovery and stable deferred-transfer cases reuse the existing
ClipboardInput boundary (`tests/browser/large-paste-cases.ts`); these focused cases
do not replace the owning broad FMT/native qualification.
