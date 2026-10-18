# Mobile extension admission harness

Run from core with the repository's Node/npm toolchain:

```sh
npm run build
npm run test:mobile-extensions -- --group capabilities
node --test tests/consumers/mobile-extensions/disabled.test.mjs
```

Set absolute worktree-owned `EDITAC_MOBILE_EXTENSIONS_OUTPUT` and
`EDITAC_MOBILE_DISABLED_OUTPUT` directories to retain package tarballs, source
pins, per-case browser observations, emitted bundle graph and raw failures.
The dispatcher rejects unknown/unimplemented groups, zero browser execution,
skips, changed source and incomplete teardown. The graph check deliberately
fails when optional implementations remain in the minimal packed consumer.
Passing browser cases alone cannot close MEX-1.1.

The 32-case index pins original catalog text and owners. Each later parent adds
its executable mechanics; pending index entries are not passing observations.
The configured profile cases use the current extension facade. Advanced legacy
code/table/reorder/slash/reference rows retain compatibility coverage separately.
Required resources are counted by the existing mobile harness; optional allocation
stacks and explicit emitted byte contributions are recorded separately. Prepared
share rejection/absence tests exercise the existing baseline fallback port, not
the future format presenter. Platform, actual OS input/AT, performance and release
qualification remain in the original owning gates.
