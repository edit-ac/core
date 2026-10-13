# Input-policy qualification fixture

Run `npm run build`, then `npm run test:browser -- input-policy`. The named runner executes pinned Chromium, Firefox and WebKit. Each suite packs the real core, serves its WASM from an isolated consumer, recovers a real checkpoint and attaches production renderer/selection/storage to the internal qualification protocol.

Initial semantic state is independently authored: `alpha` and `independent`, collapsed caret at UTF-16 offset 5. Test bodies specify expected content, caret, disposition and update/history/journal effects. `mutate` changes actual DOM text; it never writes expected text into the engine. Remote insertion uses a real restored peer and binary differential update. Owner deletion uses the already qualified deletion-probe tombstone port, explicitly prepared evidence.

Physical browser typing/deletion and deliberate Enter have trusted native event traces. All composition sessions and fallback permutations are prepared DOM/event replay. No OS IME/device claim follows. Facts retain per-case snapshots/traces, provenance, profiles, packed artifact hashes, source hashes before execution and a source-stability check afterward. Temporary consumers, owned browser controllers and loopback servers are torn down in failure and success paths.

Use `EDITAC_INPUT_POLICY_OUTPUT` for durable output. Source roadmap and tracking state are separate; decision and gate evidence live in `../architecture/decisions/004-browser-input-composition.md` and `../architecture/evidence/browser-input-policy/receipt.json`.
