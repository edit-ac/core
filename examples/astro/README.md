# Astro task editor

This example is qualified with Astro 7.3.8 and Node adapter 11.1.7. It uses
`@edit-ac/astro`, core and web with no React runtime. The server renders empty
hosts; the processed browser script opens the persisted task and read-only notes.
ClientRouter navigation disposes and remounts their existing identities.

From core, build and host static output:

```sh
npm ci --ignore-scripts
npm run build:wasm
npm run build
cp packages/core/dist/wasm/editac_wasm_bg.wasm examples/astro/public/engine.wasm
npm exec -- astro build --root examples/astro
npm exec -- astro preview --root examples/astro
```

For standalone SSR:

```sh
EDITAC_ASTRO_MODE=ssr npm exec -- astro build --root examples/astro
HOST=127.0.0.1 PORT=4321 node examples/astro/dist-ssr/server/entry.mjs
```

Stop previews with Ctrl+C. Vite emits the JS glue; `/engine.wasm` is the explicit
binary URL. The SDK must already be built. To qualify the same sources against
installed tarballs, run `node --test tests/docs-examples.test.mjs` from core.
`npm run check:astro` separately uses the prepared lifecycle fixture; the default
application build contains no fixture. Its checker pins TypeScript 6.0.3 and
@astrojs/check 0.9.10, while the SDK compiler remains TypeScript 7.0.2.

Save locally before navigating. Local save never establishes remote settlement.
Export recovery retains byte arrays from the live replica or unsaved disposal
reports; the reports survive ClientRouter navigation in module memory and must be
exported before the tab closes. The host owns authentication, uploads and any sync
transport. See [integration and recovery](../../docs/integration.md) for format,
native/device and release limits. No package is published and no performance
budget or native parity is claimed.
