# Bounded matching and host resolution

`Extension.create` attachment contexts expose `context.match(options)`. This installs one operation-indexed ModuleRuntime subscription and returns a managed controller. Disposal is automatic with the attachment; `invalidate()` cancels pending intent and clears its cache when the host changes authorization, policy, catalog or principal. Call it at logout/revocation, including when a capability changes away and back between callbacks.

```ts
onAttach(_options, context) {
  const matcher = context.match({
    contextUtf16: 128,
    paste: 'ignore',
    match(window) {
      const results = [];
      for (const m of window.text.matchAll(/\bASD-[0-9]{1,6}\b/g)) {
        if (!/[\s.,;!?]/.test(window.text[m.index! + m[0].length] ?? '')) continue;
        results.push({ start: m.index!, end: m.index! + m[0].length, text: m[0] });
      }
      return results;
    },
    permission: () => ({ principal: 'alice', tenant: 'team', authority: 'tasks',
      revision: 'current-host-policy-version', lookup: true, apply: true }),
    resolve: ({ text, signal }) => preparedCatalogLookup(text, signal),
  });
  // Host policy subscriptions should call matcher.invalidate() and be registered
  // with context.cleanup. The resolver owns all credentials and transport.
}
```

The callback returns relative UTF-16 positions in the supplied window. Declare delimiter rules in that callback; input is not a whole document. Only matches intersecting the changed range or its immediate boundary are eligible. Native local text-input commits trigger matching; paste requires `paste: 'match'`. `literal(patch)` can bypass host-specific literal input. Remote/replay, open, inspection, export, format-only changes, undo and redo never initiate a lookup. Undo/redo cancel pending intent and clear caches; a new eligible local action is required to reapply. Active composition and unavailable/readonly attachment authority suppress admission; composition is not an OS support claim.

Existing code blocks, code/link runs and extension data are excluded. Oversized or ambiguous projection windows fail closed. A patch processes at most eight changed ranges and 64 projected nodes, each at most 128 spans/runs. Context radius is 1–1024 UTF-16 units (default 128); one window is at most three radii. A callback may return at most 1–32 matches (default eight). UTF-16 coordinates must preserve exact source text; the engine owns Unicode anchor resolution. These are deterministic work limits, not timing qualification. A very fragmented block may need another eligible action after simplification; it does not trigger a full-document fallback.

The SDK captures engine-owned anchors before awaiting. It retains literal text while pending. It checks document/attachment identity, host principal/tenant/authority/policy, readonly generation, anchor resolution, exact current text and exclusion context before application. An unrelated edit can rebase the anchors; intersecting edits invalidate intent even if text is subsequently restored. A manual link wins. The default successful application is one existing prepared link-mark command, preserving authored source and other formatting. An optional `prepare({range,text,href})` supplies an alternative prepared command; it is trusted host code, revalidated after return, and cannot bypass the engine's permission/preparation/history boundary. Do not implement a multi-step mutation sequence in this callback.

Results are `{status:'available', href}` or `{status:'missing'|'forbidden'|'unavailable'}`. Available hrefs must be safe HTTP(S) links without userinfo and at most 2048 UTF-16 units. No URL is fabricated, fetched or inferred. Unsupported protocols and private custom-reference identities require their existing explicit catalog/activation owner; there is no public metadata fallback. Host adapters own egress and authorization under the link-resolution contract. Missing/denied/invalid/error/cancelled/deadline responses leave text and history unchanged. No response description, credential or provider error is persisted or exposed in status callbacks.

Each controller owns its cache and pending map. Keys include an opaque permission generation scoped to principal, tenant, authority and policy; results never cross editors or host scopes. Concurrency is 1–8 (default four), queue 0–32 (default 16), deadline 1–30000 ms (default 5000), and cache 0–64 entries (default 32). Positive cache TTL is 1–300000 ms (default 5000); negative TTL never exceeds 250 ms. Pending duplicates at the same target coalesce. Expiry and FIFO eviction bound cached data. Cancellation settles the caller, but the existing ServiceLifecycle retains the occupied slot of an uncooperative resolver until it finishes, preventing a replacement stampede. `onStatus` receives only a transient enum, never a response body.

Matchers, resolver callbacks, status handlers and prepare hooks are trusted host code. AbortSignal does not preempt an infinite loop or terminate an unresolved host promise. Heavy or untrusted parsing belongs in an isolated worker; do not send host credentials into document state, logs or worker messages. No provider is built in, and the canonical harness uses prepared responses only.

Verification: `node scripts/test-extension-dx.mjs --group matching` packs and installs public modules with authenticated unchanged WASM. Browser fixtures cover current/stale/denied/out-of-order results, real input/clipboard, engine anchors, history and peer updates. Synthetic composition preserves ownership but does not qualify an actual device or OS IME.
