# @edit-ac/react

Optional lifecycle bindings over `@edit-ac/web`. React renders an empty host;
the shared Rust/WASM SDK owns the document, selection and editable DOM. There is
no controlled `value`, children or per-keystroke React document state.

This package remains private and unpublished. React and React DOM 19.3.0 are the
pinned verification candidates; the peer range is restricted to React 19.3.x.
Other React versions, packed application consumers and release qualification
remain separate gates.

```tsx
import { useMemo } from 'react';
import { EditorHost } from '@edit-ac/react';

function Task({ identity, databaseName, browserPorts, onError, onDispose }) {
  const options = useMemo(() => ({
    identity, databaseName,
    assetUrl: '/assets/editac_wasm_bg.wasm',
    ...browserPorts,
  }), [identity, databaseName, browserPorts]);
  return <EditorHost options={options} attributes={{ className: 'task' }}
    onError={onError} onDispose={onDispose} />;
}
```

Create and persist the initial checkpoint explicitly through the core/web SDK
before opening a new document. Recovery never invents content. Memoize options:
replacing their identity is an explicit teardown and new session. Keep browser
ports outside server rendering, for example by constructing options in a client
boundary. Importing the package and rendering an empty host on the server does
not access browser globals or initialize WASM.

`onReady(editor)` exposes the existing imperative handle after recovery and
surface activation. Commands, Markdown paste, scoped patch subscriptions,
`attachSync` and local `flush` are the web SDK's methods. `readOnly` changes input
authority without replacing the replica. The binding does not authenticate,
upload assets, seed documents or guarantee remote durability.

For a custom empty host, `useEditor(rootRef, options, events, readOnly?)` returns its handle
(or `null` before creation). `useEditorState(editor)` is an optional scoped status
subscription for a separate toolbar. It caches snapshots for React's external
store contract; it does not subscribe to document patches. Do not render React
children into the editable surface.

Cleanup disables input immediately and flushes local storage before disposal.
Replacement waits for the previous same-host or same-document teardown, including
StrictMode's setup/cleanup replay. `onDispose(result)` can arrive after React
unmounts. Keep recovery handling outside component-local state. If flushing fails,
`onError(error, editor)` runs while recovery is still available; cleanup then uses
the web SDK's explicit report policy and passes the resulting unsaved/recovery
report to `onDispose`. Without an error callback, the binding logs the failure.
Do not treat a cleanup request as a completed save, or ignore an unsaved report.

Run `npm run build` and `npm run test:browser -- react` from the repository root.
The deterministic fixture uses the real WASM engine and local storage; prepared
failures qualify lifecycle behavior, not provider quality or physical devices.
Publishing stays disabled until the architecture's artifact/release gates pass.
License: Apache-2.0.
