# Optional writing completion

Import `aiCompletion` from `@edit-ac/web/ai/completion`. Supply it through the
existing BrowserEditor `slash` lifecycle port, using the same AiHost as the
host's optional AI transport:

```js
slash: aiCompletion(host, {
  enabled: true, debounceMs: 1000, contextBytes: 4096, outputBytes: 512,
  acceptKey: 'Tab', attached(completion) { /* retain for host lifecycle signals */ }
})
```

Omitting `enabled: true` leaves completion disabled. AiHost still requires
capability `completion`, explicit request/context/output/time bounds, transmission
policy and quota admission. The Suggest writing control starts a manual request.
Only the captured paragraph prefix is sent; code, inline code, module atoms,
marked text, dictation, pointer selection and selected ranges are excluded.
Over-limit context rejects before transport. The optional server recipe in
`examples/ai-completion-backend` uses bounded SDK generateText with prepared tests.

Ghost text is an inert sibling overlay outside the contenteditable projection.
It does not affect UTF-16 offsets, native selection, copy, export, CRDT state,
storage or history. A complete suggestion exposes polite live status and visible
Accept/Dismiss controls. Tab accepts a valid visible suggestion; `acceptKey` can
be `Enter` or `false`. Other Tab handling stays with the existing input middleware.
Escape dismisses. Acceptance uses the host's existing commit port and one undo
group. Unrelated remote content survives acceptance and undo.

Call `setDictating(true/false)` for dictation not represented by DOM composition.
Call `invalidate()` before a host permission/document transition, and
`setReadOnly`, `setEnabled` or `dispose` with their normal host lifecycles.
Target/context changes, caret moves and blur outside the editor/controls cancel
pending work and remove the ghost. Superseding requests abort the old transport;
late responses cannot publish or commit. Backend cancellation must also reach the
SDK. Cancellation does not imply a provider billing refund.

The named test suite uses a fixed browser clock, actual Chromium keyboard/touch,
real packed BrowserEditor/storage/WASM and the pinned SDK with a prepared model.
These are browser integration results. Actual OS screen-reader qualification,
model accuracy, production providers, deployment and release remain outside this
local delivery.
