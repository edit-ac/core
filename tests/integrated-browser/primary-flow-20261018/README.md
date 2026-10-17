# Test the configured editors together

PIN-1.3 composes the landed configuration subset with the production packed
mobile/browser and host-agent harness owners. From the **core** checkout, use
Node 24.19.0 / npm 11.17.0 and Rust 1.97.1:

```sh
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$HOME/.cargo/bin:$PATH"
npm run build
cargo build -p editac-session --features native-store --example host-realtime-owner --locked --offline
EDITAC_PRIMARY_FLOW_OUTPUT="$(mktemp -d "$PWD/.tmp-configured-preview-XXXXXX")" node tests/integrated-browser/primary-flow-20261018/preview.mjs
```

Open the printed loopback URL. The two collaborative editors start with `base`
and `other` and use separate local journals for the same document; the local
note starts with `Local note` in an independent document. All content is disposable.
The preview uses the authenticated generated members pinned by the PIN-1.2
receipt, not the active PARALLEL output. Keep the sibling architecture checkout
and its retained artifacts available. No credentials or provider are used.

1. In the first collaborative editor, select `base` backward and press **Bold**.
   Find `base` with **Find in document**, replace all with `found`, then put the
   caret in that block and press **Alt+ArrowDown**, or use **Move block down**.
   The peer converges to `other` / `found`. The local note keeps its own text,
   spelling policy, disabled Italic command and absence of Search/Reorder.
2. Type in either collaborative view. The prepared local bridge pumps and
   reconnects the existing sync owner once per second; the other view follows.
   Use Command-Z on macOS or Control-Z elsewhere in the first editor. Human undo
   changes that view's local intents and preserves edits from its peer.
3. Press **Apply prepared host-agent edit**. It inserts `Agent ` into the first
   current block through the real authenticated host adapter and serialized
   Rust Session/SQLite owner. A same-ID retry returns its original receipt;
   the edit reaches both views through ordinary CRDT synchronization.
4. Type in the local note, then press **Flush and reopen**. All three documents
   retain their text/marks/order and identity through production IndexedDB.
   Recovery creates no replacement document and does not persist local undo stacks.
5. Stop the command with Ctrl-C. It closes both loopback listeners, the host
   process and the temporary installed consumer. Logs and the host SQLite evidence
   remain in the chosen output directory. No preview is required to stay running.

For focused automated correctness checks (three named journeys per profile):

```sh
for browser in chromium webkit; do
  for profile in desktop portable-mobile; do
    EDITAC_PRIMARY_FLOW_BROWSER="$browser" EDITAC_PRIMARY_FLOW_PROFILE="$profile" \
      EDITAC_PRIMARY_FLOW_OUTPUT="$(mktemp -d "$PWD/.tmp-configured-flow-XXXXXX")" \
      node --test --test-reporter=tap tests/integrated-browser/primary-flow-20261018/product.spec.ts
  done
done
EDITAC_PRIMARY_FLOW_OUTPUT="$(mktemp -d "$PWD/.tmp-configured-preview-check-XXXXXX")" \
  node tests/integrated-browser/primary-flow-20261018/preview.mjs --check
```

The automated contexts include a 390×740 touch viewport. They exercise actual
installed BrowserEditor, Rust/WASM, Session, IndexedDB, history, search, reorder,
ordinary sync and actual host SQLite admission. Peer/agent JSON and wire delivery
are deterministic prepared transports. These checks prove neither provider
quality nor native mobile touch/keyboard/IME/AT, OS policy effects, performance,
budget, platform support or release readiness. Missing configuration families,
loading, recipes and the broader SDK-1.11 parent remain outside this landed subset;
a newer qualified PARALLEL delivery must be integrated separately. No deployment,
publication or paid inference is authorized by these commands.
