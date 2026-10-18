# Optional local format consumer

`@edit-ac/formats` loads its bundled conversion WASM only after an explicit request,
in a disposable dedicated module worker. It is private and is not published.
The base editor does not depend on this package. Build with
`node scripts/build-formats.mjs` using the locked Node/Rust/bindgen toolchains.

The initial public worker return covers the existing bounded RTF 1.9.1 profile and
explicit UTF-8 CSV/TSV table dialects and semantic DOCX/ODT/EPUB and bounded PDF publication export and DOCX text/list/simple-table/original-PNG import. ODT/EPUB import are unavailable
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
node and parser budgets; the result envelope is bounded to 8MiB. The bundled module fetch is capped at16MiB including fonts. The compiled
WASM memory has a 64MiB maximum. This bounds linear memory, not the browser's total
JS/renderer heap. A trap retains original recovery bytes and does not commit.

The worker reads only explicitly supplied bytes/checkpoint and its bundled WASM.
The launcher fetches only its bundled same-origin WASM with credentials omitted,
then passes a compiled module to the worker. The worker freezes ambient
fetch/socket APIs; hosts must serve the worker with `connect-src 'none'`
and a suitable script/WASM CSP and serve immutable same-origin assets. CSP enforcement,
whole-process memory policy, cross-engine host integration, journal durability,
asset ingest, native sandboxing and reader/manual/platform/release qualification
remain explicit roadmap31–36/37 work. No remote converter, provider,
credentials or network fallback are included. Costs reported by tests include
checkpoint capture, worker startup/load, Session restore, conversion, transfer,
live commit/reopen and worker termination; memory samples state their limits.

DOCX, ODT, EPUB and PDF export use their existing optional semantic writers and captured checkpoint.
Supply `originalAssets: [{identity, actions: ['read'], bytes}]` for each admitted
PNG. Obtain bytes through the owning attachment service (for example
`AssetSession.retainedSource(reference, grant)`), with explicit host permission.
Descriptors grant no authority. The client copies grants and bytes with the
checkpoint; the worker validates shared read requests, exact digest/length/PNG
identity and budgets. Missing or denied assets fail without a partial artifact.
No host operation, URL resolution, upload or lifecycle mutation occurs in export.
The aggregate original-byte allowance is 1 MiB, with at most 64 unique assets.
DOCX output reports regenerated package/page/style/metadata defaults. Unsupported
semantics require explicit loss approval; results and failures retain recovery.

DOCX import reuses the guarded semantic importer for text, marks, headings,
links, direct lists, v1 rectangular tables and paragraph-isolated original PNGs.
Unsupported constructs return complete diagnostics and require explicit loss
approval. Media needs exact SHA-256 bytes, host identities and explicit grants in
`importGrants`; absent authority returns `AssetStagingUnavailable` and retains the
original package/checkpoint. Media results require
`await prepared.commitAssets(owner, immutableJobId, approvedHostTransport, sourceRecoveryGrant)` with
an `openEditorStorage` owner for this exact engine. The method durably stages
the complete package at `immutableJobId + '_source'` and image originals, explicitly dispatches image ingest with immutable operation IDs, and uses
one shared `commitPreparedAssets` transaction. Its completion includes the actual
`localCommit`, which the save owner must correlate to the returned revision.
Caller source remains available after stage failure; retained originals are
recoverable via `assets.preparedSource(job, reference, freshReadGrant)` after subsequent failure/cancellation.
`cancel()`/`dispose()` fence active work. Recovery/reopen performs no host work;
cleanup remains explicit. Ordinary `commit()` refuses media. No remote conversion,
implicit grants, insertion compensation or layout/source-byte fidelity is claimed.

ODT export uses the qualified ODF 1.3 semantic writer with the same approved original PNG transport. It preserves the declared text/marks/headings/lists/v1 tables/links and image accessibility labels, reports regenerated package/style/metadata defaults, and rejects unapproved loss. ODT import remains unavailable in this public worker. Independent reader/schema qualification covers generated artifacts, not arbitrary suite layout or native platform wiring.

EPUB export uses the qualified EPUB3.3 reflowable profile: top-level headings
start deterministic chapters, the flat TOC follows spine order, and the first
chapter supplies the title. Language is `und`, the identifier derives from content,
and modified time is fixed; source/private metadata is omitted with diagnostics.
Authorized original PNG bytes, alt text and captions are preserved. Unsupported
content requires explicit loss approval and retains the captured recovery checkpoint.
No fixed-layout, pagination, DRM, scripts or implicit remote resources are supported.

PDF export uses the qualified bounded publication profile with selectable shaped
Latin/Arabic text, rich marks/headings/lists, rectangular tables and approved
original PNG images. Six exact licensed Noto faces are embedded in the optional
WASM module; the build receipt pins their bytes and includes OFL notices. There
is no host-font lookup or resource download selected by document content. The
worker has the same 64MiB linear-memory cap, outer termination/deadline and denied
network policy. The publication profile caps text at64KiB, pages at8 and output
at4MiB; exceeding a limit returns no partial artifact. Missing font coverage,
mixed-script or unsupported structures return diagnostics/recovery. The declared
layout is420x360pt with28pt margins, not arbitrary original pagination. PDF import
is rejected; PDF/UA, archival compliance and native host integration remain open.
