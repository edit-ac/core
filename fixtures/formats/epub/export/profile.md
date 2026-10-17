# Captured EPUB 3.3 export profile

CNV-1.15 is independent of import. Enable only `epub-export`, fix the job to
`epub::export::PROFILE`, and invoke `export` against the captured Session revision.
The result carries that revision; live edits never enter the artifact. Loss
requires explicit approval, every diagnostic remains visible, and missing shared
fragments are rejected even with approval. Carry imported omission reports with
`Provenance::from_import` and the identical original input; the host retains that
input separately. Conversion completion does not mean journal durability.

The writer generates one chapter at each top-level heading (levels 1–6). Content
before a heading gets an Untitled publication chapter; empty titles become
Untitled chapter. Nested list headings remain in the same chapter. A flat TOC
lists all chapters once in spine order. The first chapter title is the publication
title, language is explicitly undetermined (`und`), identifier hashes serialized
chapter and original-media content, and modified date is the fixed epoch
`1970-01-01T00:00:00Z`. The report discloses these generated defaults. Original
navigation hierarchy, author, language guesses, private metadata and timestamps
are not copied. No arbitrary source package or pagination preservation is claimed.

Supported paragraphs/headings, all five text marks, links, ordered/bullet lists,
rectangular v1 tables, and standalone original PNG images use only escaped XHTML.
Whitespace is explicit (`pre-wrap`, br and CR references); table alignment, image
alt, caption and intrinsic dimensions are preserved. Hyperlinks are inert and
normalized through the shared URL policy. No script, form, stylesheet dependency,
remote resource, embedded font, DRM or fixed-layout content is emitted. Unsupported
blocks/containers/atoms/marks need a complete report and explicit loss action;
registered-inline/marked-atom transfer remains with the shared owner.

Bounds: job input/output/node/deadline limits plus <=256 chapters, <=4096 UTF-8
bytes per title, <=9 list depth, <=64 original image references and <=512
diagnostics. Chapter buffers charge cumulative serialized bytes before growth;
original media length is checked before authorized reads, PNG identity/dimensions
and decode budgets are checked, and the ZIP sink rejects growth/seeks beyond the
output limit. Cancel, asset or output failure returns no artifact and aborts only
the job. Resources are never fetched from the document or host font environment.
Prepared execution enforcement is a contract; OS sandbox wiring is not qualified.

## Dependency and reference gate

Reuses import's exact optional pins and prior license/compile gate: zip8.6.0
(default=false, deflate), quick-xml0.41.0 (default=false, encoding), and
flate2 1.1.10 (default=false, zlib-rs). There is no new runtime dependency,
container stack, HTML parser or default-graph edge. The shared captured-fragment
and AssetWork contracts are unchanged at the eight pinned prerequisite hashes.

Primary reference: [EPUB 3.3, 13 January 2026](https://www.w3.org/TR/2026/REC-epub-33-20260113/),
OCF ZIP/mimetype/container, required identifier/title/language/modified metadata,
manifest/spine and navigation/XHTML. Optional ZIP API:
[ZipWriter8.6.0](https://docs.rs/zip/8.6.0/zip/write/struct.ZipWriter.html).
The declared deliberately bounded writer emits the reflowable vocabulary only.

Validation tools are separate: [EbookLib0.20](https://github.com/aerkalov/ebooklib)
(AGPL-3.0), lxml6.0.2 (BSD-3-Clause plus bundled libxml2/libxslt notices),
six1.17.0 (MIT). They inspect generated artifacts only, never runtime user inputs.
The [official reader API](https://docs.sourcefabric.org/projects/ebooklib/en/latest/tutorial.html)
opens actual packages and resolves spine/TOC/metadata/resources; lxml parses XHTML
with entities/network disabled. `EDITAC_EPUB_READER_PYTHON` must point to an
explicitly provisioned environment with these exact versions. No test installs
or downloads packages. Source-derived full projections and nine output mutations
verify semantics independently of edit.ac's writer/importer. Target proof is
native Session runtime and actual WASM writer compilation, not reader UI,
platform sandbox, EPUB conformance certification, accessibility certification,
viewer rendering, packed release or broad consumer support.
