# Project kickoff: a structural callout, highlight and local menu

This local-only recipe uses `module:editac.callout` version 1, the existing
Rust-admitted atomic content block. It is not the historical `[note]` recipe,
which still maps to heading/bold semantics. The callout retains its NOTE/TIP/etc.
kind, body Markdown and exact source. Its optional presenter uses an accessible
`aside`, but the committed engine tuple establishes the block semantics.

`prepareCallout(codec)` calls the production optional Markdown codec. The
`demo.kickoff` factory uses `Extension.create` to insert that prepared fragment
at the captured target. `demo.highlight` registers a versioned mark and annotates
Friday without owning another document or history. `bindEmphasisMenu` captures
the existing bold command before pointer focus changes and releases it on use or
disposal. Keyboard/host command UI can use the same public capture boundary.

## Two supported compositions

For the configured authoring API, use `createKickoffExtensions(codec)` in the
editor's `extensions`. The engine's readable fallback presents the callout even
without a custom presenter. The complete tutorial fixture imports only public
`@edit-ac/core`, `@edit-ac/core/extensions`, `@edit-ac/web`,
`@edit-ac/web/modules` and `@edit-ac/markdown` APIs.

For the advanced content presenter, flush and destroy that view, then reopen the
same database and identity with the public `content: calloutPresenter(codec)`
port and a frozen `ModuleRegistry` containing `highlightDefinition`. Do not pass
legacy `content` together with configured `extensions`: that combination rejects.
The test fixture demonstrates both sequential mounts over the same persisted
engine document. A remount is not a second writable document or hot schema change.

The presenter edits the retained callout source through one `atomicContent`
command. The command compares the complete expected descriptor and a stable
source-owned offset-zero anchor, then replaces the same-family descriptor and
canonical fallback at the same node. It does not delete/reinsert the block or
issue sequential semantic edits. The existing Session commit, local journal,
readonly, preparation, history and renderer lifecycle remain authoritative.
Body Markdown is retained source; this recipe does not implement a nested rich
text editor inside the callout. Highlight/menu examples operate on the ordinary
editable Due Friday paragraph alongside that block.

Call `disposeMenu()` before destroying the editor. A source presenter cancels its
pending preparation and removes all listeners on disposal. Invalid source,
stale preparation, readonly and cancellation do not commit. Callbacks are trusted
bounded host code, never document-selected executable content.

## Reproduce local proof

Use Node 24.19.0/npm 11.17.0 and Rust 1.97.1. Build production WASM after the
callout command change and freeze its exact artifacts using the architecture
qualification setup. From the core repository run:

```sh
node scripts/test-structural-callout.mjs NEW_OUTPUT FROZEN_ENGINE_MANIFEST
```

The runner packs and installs the three public packages offline with lifecycle
scripts disabled, verifies every installed member, bundles without workspace
aliases, and runs independent production-browser cases. All transports stay on
loopback. Its receipt records exact hashes, native production runtime identities,
nonzero counts and browser/server/consumer teardown. Missing or skipped cases
cannot qualify the recipe. The architecture candidate manifest binds this source,
the owning engine/codec ranges and those exact installed bytes.

Markdown represents the callout, but a custom highlight can require explicit
loss diagnostics and complete recovery data. Absent/unknown extension versions
retain their opaque values and initialized checkpoint. Do not substitute a
flattened string for recovery data. These are unpublished local candidates;
registry/release, native hosts, OS input/accessibility, cloud services and
performance qualification remain pending.
