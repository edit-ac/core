# @edit-ac/markdown

Private, optional stateless Markdown codec. Import is safe on the server and does
not load WASM. Await `initMarkdown(assetUrl)` explicitly before using
`importMarkdown(source, options)` or `exportMarkdown(blocks, options)`.
The asset is exported as `@edit-ac/markdown/wasm` for explicit host resolution.
The codec returns prepared semantic fragments; apply them through the existing
engine's validated fragment command. It owns no document, anchors or history.
Diagnostics and export recovery blocks must be retained by the host.

Browser lifecycle registration is implemented; complete default/enabled packed profile qualification remains pending; this package is not a release or a completed extension profile.

Markdown is optional. Default Task mounts paste and type Markdown-looking text literally. To opt in, initialize `initMarkdown(parserAssetUrl)` from `@edit-ac/markdown`, then pass `markdown: markdownExtension(codec)` from `@edit-ac/markdown/web` to the same editor options (plain, React or Astro). The engine retains its single document owner. Direct engine consumers call `engine.registerMarkdown(codec)`; the returned registration can be disposed. Unavailable import/export throws `CapabilityUnavailable` / `markdown-codec-unavailable` without changing content; unavailable named Markdown clipboard sources retain diagnostics and exact recovery text.

The executable Task and React examples enable Markdown with `?markdown`; the Astro client uses the same explicit option and a separately hosted `/markdown.wasm`. Serve the optional package and parser only for enabled consumers. Cleanup detaches registration with the surface and preserves existing pending-save recovery.
