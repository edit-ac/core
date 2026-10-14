# Portable extension transfer

Import `ExtensionTransferRegistry`, `exportExtensionTransfer`,
`importExtensionTransfer` and `extensionTransferRequest` from
`@edit-ac/core/extensions`. Browser consumers receive the same objects through
`@edit-ac/web/modules`. `ExtensionPresenterSession.transfer` and `.cut` use the
existing command, capability, history and storage boundary for all five presenter
protocols. These methods are prepared portable contracts; they do not access an OS
clipboard or qualify native renderers.

A data-only descriptor declares supported positive-u32 data versions, inline
marks, block styles and table metadata. Registration validates the complete set
before returning a registry, rejects duplicates and captures host codec callbacks.
Callbacks stay outside serialized data and cannot admit new engine semantics.
Their candidate fragments must pass the owning engine's shape validation and its
separate target/semantic/capability admission before commit.

```js
import {
  ExtensionTransferRegistry, importExtensionTransfer,
} from '@edit-ac/core/extensions';

const registry = new ExtensionTransferRegistry([{
  descriptor: {
    type: 'example.caption', versions: [1], inline: ['bold'],
    blocks: ['paragraph'], tableMetadata: [],
    fallback: 'inert-source-with-recovery',
  },
  codec: {
    prepare(offer) {
      return [{ attributes: { type: 'paragraph' },
        runs: [{ text: offer.payload.caption, marks: [{ mark: 'bold' }] }] }];
    },
  },
}]);
const offer = importExtensionTransfer(serializedOffer);
const prepared = registry.prepare(engine, offer, plainPaste);
const result = await presenterSession.transfer(prepared, engine, retainedRange);
```

The host retains and releases selection anchors and returned caret/selection
tokens. Preparation captures the exact writer identity and revision; another
writer, changed document or reused stale preparation rejects. Two views sharing
one writer can consume the same preparation through that writer's host boundary.
An exported inert offer remains usable after its source view is disposed.

Plain paste bypasses every codec and preserves the destination style using a
literal prepared replacement. Unknown types, unavailable codecs and unsupported
versions return `mode: 'fallback'`, explicit diagnostics, literal source blocks
and the exact original envelope in `recovery`. Accessors, executable values,
cycles, excessive nesting and excessive data reject without interpreting them.
Input and candidates are bounded to 1 MiB, 65,536 data cells and depth 16;
engine fragment limits remain independently enforced.

The host must display fallback diagnostics and retain/export the recovery envelope
alongside its persisted document when richer payload recovery is required.
Literal source alone cannot reconstruct opaque payloads. The conformance harness
stores recovery envelopes separately and restores the committed source through
the real storage checkpoint. It does not claim that an unknown atom has been
admitted to the engine, or that an ordinary clipboard copy carries its envelope.

Cut checks current mutation capability before calling the host's clipboard writer.
The writer must acknowledge all required flavors by returning `true`. Refusal,
failure, cancellation, disposal, changed revision or capability revocation prevents
deletion. Final semantic/permission checks still occur at the shared commit
boundary. No transfer method fetches an asset or executes a formula.

Current table v1 semantics admit rows, columns, alignment, the first header row and
inline marks/links/code. Table v2 admits bounded paragraph/heading/code cell blocks, explicit header flags
and nonoverlapping row/column spans with null covered cells. Its exact tuple survives
portable structured transfer, history and storage. V1 remains unchanged; v1
presenters show fallback for v2. Markdown export reports a source fallback and
retains the complete typed recovery fragment; source alone cannot recover all
metadata. Unadmitted richer shapes, math and future atoms still require explicit
inert recovery; ordinary unknown-content admission remains unfinished.
Version callbacks may prepare explicit compatible candidate data, but this API
does not migrate document epochs or reinterpret delayed offline updates.

Run `node --test tests/extension-formatting.test.mjs` after the locked production
WASM and packages are built. The corpus is
`fixtures/extensions/clipboard/conformance.json`; the canonical harness uses
packed public imports, production WASM, the owning clipboard/presenter/storage
middleware and deterministic journal transports. Actual OS/device clipboard
qualification stays with the downstream platform owners.
