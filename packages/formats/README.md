# Optional local format consumer

`@edit-ac/formats` loads its bundled conversion WASM only after an explicit request,
in a disposable dedicated module worker. It is private and is not published.
The base editor does not depend on this package. Build with
`node scripts/build-formats.mjs` using the locked Node/Rust/bindgen toolchains.

The initial public worker return covers the existing bounded RTF 1.9.1 profile and
explicit UTF-8 CSV/TSV table dialects. DOCX, ODT, EPUB and PDF export are unavailable
at this package boundary until separately packaged and qualified. PDF import is
always export-only, including a PDF signature mislabeled as another supported
format. Existing native adapters retain their own evidence and limitations.

Create a client with `createFormatClient()`. Call `prepareImport(engine, options)`
with original bytes, a live anchor range and a format. CSV/TSV also require
`newline: 'lf' | 'crlf'` and `header: boolean`. Preparation reads a fixed checkpoint,
restores a detached shared Session, runs the real bounded job/adapter and returns
shared transfer fragments and complete diagnostics. It never writes the live
engine. `commit()` validates the captured live revision, then uses the existing
SDK fragment prepare/commit once, preserving its admission and undo boundaries.
Review unsupported diagnostics and explicitly set `approveLoss` before preparing
again when that lossy action is intended. Original bytes remain available on the
result or `FormatError.original`. Results and post-capture failures also retain
the exact SDK `recovery` checkpoint; retain them under the host's recovery policy.
The caller owns and releases its live anchors. Do not serialize anchor tokens.

`export(engine, options)` captures one checkpoint and returns bytes, diagnostics,
profile, original bytes, a live revision number and the Session's exact observed
revision token. CSV/TSV requires `selected` with the captured table node ID and an
explicit newline. Exact output is the default. `safe: true` selects the separately
named spreadsheet-safe profile; transformed cells have visible diagnostics.
Completion is not a saved/durable revision. The host correlates successful
write/close with that captured revision, and keeps later edits dirty.

One client admits one job; one module realm admits at most two active workers. AbortSignal, `cancel()` or `dispose()` terminates the
worker and fences results. The deadline defaults to 10s and can only be reduced.
Input and checkpoint are each bounded to 1MiB; the adapter has existing output,
node and parser budgets; the result envelope is bounded to 8MiB. The compiled
WASM memory has a 64MiB maximum. This bounds linear memory, not the browser's total
JS/renderer heap. A trap retains original recovery bytes and does not commit.

The worker reads only explicitly supplied bytes/checkpoint and its bundled WASM.
The launcher fetches only its bundled same-origin WASM with credentials omitted,
then passes a compiled module to the worker. The worker freezes ambient
fetch/socket APIs; hosts must serve the worker with `connect-src 'none'`
and a suitable script/WASM CSP and serve immutable same-origin assets. CSP enforcement,
whole-process memory policy, cross-engine host integration, journal durability,
asset ingest, native sandboxing and reader/manual/platform/release qualification
remain explicit roadmap31–36/37 work. No fonts, remote converter, provider,
credentials or network fallback are included. Costs reported by tests include
checkpoint capture, worker startup/load, Session restore, conversion, transfer,
live commit/reopen and worker termination; memory samples state their limits.
