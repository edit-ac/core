# Shared editing regression contract

Run with Node 24.19.0:

```sh
node --test tests/editing/fixture-loader.test.mjs
node node_modules/typescript/bin/tsc -p tests/editing/tsconfig.json
npm run test:editing -- --group fixtures
```

`fixture-loader.ts` consumes the sibling architecture manifest, recipes and catalogs directly and reuses its planning validator. Catalog rows, source-authored variant clauses, declared platform/profile constraints and risk policies remain planned metadata. Capability bindings require both declared capabilities and implemented action handlers. Known groups without runtime suites fail explicitly; future owners add their named suites to the dispatcher.

`driver.ts` accepts an actual `EngineRuntime`; each driver creates an isolated v5 document identity and alias registry. New aliases bind to the engine-returned structural caret, never matching text. A single prepared fragment handles replacement. For text replacement without an explicit engine caret, the adapter resolves a retained right-biased upper endpoint, as the production text adapter does. Snapshots read the engine projection; expected snapshots stay architecture-authored. Publication counts come from real update subscriptions. The clock is explicit and monotonic; it does not fabricate history support.

The initial `rgs-paragraph-v1` profile supports unmarked paragraphs, text selections, split, hard break and typing. Code/marks, pending-mark overrides, history selection, input/DOM, asynchronous ownership and other capabilities require owning adapters. The fixture test uses the SDK-qualified default core tarball in `architecture/evidence/browser-size-optimization/compound-order-2/default/`, unpacks it without workspace aliases, loads its public runtime and closes its private WASM asset server and temporary package in teardown.

Evidence distinguishes corpus binding, representative recipes and partial replacement checkpoints. SEQ-13/14 first-checkpoint evidence does not qualify their undo/redo/sentinel steps. Six corrupted expectations demonstrate snapshot sensitivity; this is prerequisite evidence for G14, not full guard/coverage qualification. No native/device, provider-quality or exhaustive variant claim follows from these tests.
