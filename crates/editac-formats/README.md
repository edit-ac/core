# Optional local format boundary

CNV-1.1 delivers a capability contract, import admission and a bounded complete
output builder. It installs no converter, font, network transport or filesystem
writer. All seven new format records remain `planned-unavailable`; import and
export qualification are separate. The crate is an independent Cargo workspace
to avoid changing the common owner's workspace manifest/lock or the minimum
editor graph. Its default feature has no runtime dependencies. Its only test dependency is the
already-used, exactly locked `serde_json` 1.0.152.

`fixtures/formats/profiles.json` records version 1 profiles, limits, fidelity,
diagnostics, targets and the owners of pending dependency/asset selection. A
contract compilation target does not qualify a converter on that target. The
registry exposes only the optional new profiles. Existing Markdown, safe HTML,
UTF-8 text and semantic JSON routes continue through `editac-markdown` import/
export, `editac-html` and the existing core/Session prepared fragment APIs.
There is no second baseline parser or semantic model here.

`admit_import` examines the selected profile, filename, MIME and the first 1024
bytes for PDF hints before converter dispatch. Any PDF hint returns
`FORMAT_EXPORT_ONLY`, including mislabeled input. This conservative recognition
is a routing guard, not a PDF parser. A codec must still validate its own input;
an unrecognized signature is not evidence of a valid package. DOC/PPT/XLS and
universal fidelity have no profiles.

Every failure carries a versioned code, visible message, actionable next step
and borrowed original input. Callers retain the input and unsaved edits under
their retention policy. They must present the failure; it is never a successful
Save receipt. `Output::begin` checks the requested export direction before any
converter work. `append` charges bytes/nodes/pages before buffering. Exceeding a
limit permanently poisons the builder and discards its prefix; `finish` cannot
return a truncated complete artifact after an ignored error. A successful result
labels the captured revision and actual work. It does not acknowledge a host
write, journal durability or that a later document revision is saved.

Only `rust-local-boundary` is advertised by this gate. WCF-05 uses a prepared
import-only capability and exact-budget/exhausted output cases through this
actual boundary, with converter/write effect counts. No browser/native Save UI
route or converter is claimed. CNV-1.2 owns async jobs and host completion
correlation; roadmaps 31–36 own platform wiring. Shared Session prepared edits,
`AssetWork`/`AssetStore` and identity/action-scoped host grants remain the sole
mutation and attachment lifecycle ports; this crate does not stage or publish
assets on its own.

Run `node tests/formats/run.mjs profiles` from core with Node 24.19.0 and rustup
1.97.1 on the child PATH. `tests/formats/capabilities.json` locks the exact test
commands. Unknown, missing, failed, skipped and zero-case suites fail. Logs,
counts, fixture/lock hashes and elapsed times are written below
`EDITAC_FORMATS_OUTPUT` (default `.artifacts/formats/profiles`). Later parents add
their real named suites before dispatch; names without implementation fail.

CNV-1.2 adds the optional `jobs` feature. The default graph still has no runtime
dependencies. Jobs reuse `EditService`/Session and `AssetWork`; no shared schema,
wire, Cargo workspace or ABI changes are introduced. `ConversionOwner` pairs one
Session with its exact asset store. A job freezes the selected installed profile,
source SHA-256, owned input, observed revision, target anchors, snapshot, budgets
and deadline. Registry profiles remain unavailable. Integration fixtures explicitly
use a prepared available profile and do not qualify or install a converter.

`ExecutionPort` is a trusted host enforcement contract for a browser worker or
native process. It must install the input/output ceilings, hard memory limit,
watchdog/cancellation monitor, restricted approved assets and no-network policy
before work. Missing capabilities fail closed. `JobPool` bounds active jobs;
`append` checks before allocation and poisons exhausted results. The shared
fragment planner rechecks revision, target and current authority before a single
Session commit. Full fragment metadata counts toward the output budget. Export
captures one snapshot and never reads later edits. Source buffers remain available
for recovery after cancellation/failure, within the original fixed input limit.

Asset work uses identity/action grants, bounded cumulative byte reservations,
fresh job-owned reference IDs and the existing durable intent protocol. Failure,
cancel and drop fence only those references, queue cancel/release and retain
cleanup handles if persistence fails. Hosts explicitly dispatch queued cleanup;
no network is run on drop. A committed import returns `ImportCompletion` with
its local journal receipt and transferred asset-reference bindings. The host must
retain these bindings for its existing deletion/recovery hooks. Unused import
staging and all export staging are retired. A local store failure during Session
commit follows the Session's existing recoverable-state contract; conversion does
not manufacture durability or discard the recovery export.

`SaveTransition` accepts only its own completed artifact and captured revision,
including a private per-instance correlation token. `ArtifactSink::write` stages;
`close` atomically installs the output, preserving the prior artifact on failure.
Picker cancellation, write/close failure and duplicate/foreign completions cannot
permit New/Open. Successful N completion returns false for current N+1. Artifacts
carry conversion work and revision, with no file or journal durability assertion.

Run `node tests/formats/run.mjs jobs` using the manifest-pinned toolchains. Its
real Rust integration suite uses Session/MemoryStore/AssetWork and prepared
execution, asset and file-destination ports. WCF-03 fixtures are reusable by the
platform owners. Roadmaps31–36 must implement and test real worker/process hard
limits, cancellation termination, approved asset transfer, atomic destination
writes and actual host transitions; compiling this portable boundary does not
qualify any of that platform wiring.

CNV-1.4 adds optional guarded OPC ingress through `container` (`docx-codecs`) and
`PreparedJob::prepare_container` (`docx-codecs,jobs`). It never calls the raw
DOCX reader on untrusted input. The qualified profile uses classic single-disk
ZIP, ASCII canonical part paths, UTF-8 XML and original 8-bit noninterlaced PNG
(color types 0/2/4/6). ZIP64, directory entries, alias/traversal names and other
unqualified constructs fail explicitly; input remains in the job for recovery.
Unsupported optional binary parts and active/remote content have inert structured
reports. No filesystem extraction, external fetch, preview or semantic mapping is
introduced, and production direction availability is unchanged.

`Budgets::default()` is the qualified ceiling; callers can tighten every allowance.
The guard bounds metadata before codec allocation, then checks actual inflation,
ratio, nested XML scans, attributes/text and nodes. A bounded one-byte sentinel
can establish exhaustion; failed receipts include that observed work. PNG checks
reserve pixels/RGBA allowance before fixed-scratch zlib scanline validation and
require exact scanline size, valid filters, chunks/CRCs and termination. No raster
is allocated. Original image bytes become accessible only after validation.
Repeated references consume aggregate work; rejected resources are cached only
inside the immutable package/profile. `work()` returns an immutable counter copy.

For jobs, prepare only once and call `validate_container_media` with the returned
package and the host clock. Foreign packages, failure, cancellation and timeout
abort scoped staging before a live commit. Memory admission reserves input,
inflated parts, metadata/diagnostic headroom, output and scratch; the real Session
fixtures request a prepared 32 MiB execution ceiling. Actual worker/process
sandbox enforcement remains with platform owners 31–36. Run the manifest-driven
`node tests/formats/run.mjs container-limits` for native hostile-container and real
Session/AssetWork tests, affected regressions and WASM compilation. WASM compilation
does not qualify browser execution, a sandbox, packed size or production conversion.

## Guarded DOCX text preparation

With `docx-codecs,jobs`, `docx::import::prepare_text` maps the versioned
`docx-text-semantic-v1` subset from a `PreparedJob`'s immutable input. Use
`docx::import::TEXT_PROFILE` for this import-only API. The aggregate registry DOCX
profile remains unavailable pending the structured import/export owners and host
installation. No additional dependency or minimum-editor asset is introduced.

The input is a bounded classic OPC ZIP with the conventional Transitional OOXML
`word/document.xml` main part and an explicit main content type/relationship.
Only related conventional `word/styles.xml` is consumed. Namespace URIs, rather
than prefix spellings, identify Word content. UTF-8 XML/entities are decoded by
XML rules; authored Unicode is never normalized. Paragraphs, empty paragraphs,
run text, tabs and text-wrapping breaks map to existing fragments. Paragraph
styles and explicit outline levels 0–5 map to headings 1–6. Run defaults,
paragraph/character style inheritance and direct bold/italic/strike/single
underline are supported. Style toggles and direct on/off overrides differ;
paragraph-mark properties do not become formatting for all paragraph text.
Script-specific b/i behavior beyond the declared Latin/Greek/Cyrillic,
CJK/Hangul/common emoji scope is diagnosed; Unicode text itself is retained.

HTTP(S)/mailto hyperlink relationships use the shared URL policy, never fetch,
and retain the normalized destination as a mark. Unsafe, relative, anchor-only
or missing targets retain visible text with diagnostics. Other parts, style or
theme/layout properties, complex-script formatting, tracked revisions, fields,
content controls and alternate-content branches have structured locations and
recovery actions. No arbitrary revision or alternate branch is chosen. Complex
field paragraphs retain an empty paragraph and explicit omission report rather
than accepting cached results; unrepresentable-only bodies fail with diagnostics.
This is a semantic subset, without Word pagination, original XML spelling or
source-package round-trip fidelity. The exact original remains in the job/host
recovery policy; the result carries its SHA-256.

Preparation returns immutable shared `FragmentBlock` data and a bounded report.
It never writes the live Session. Review every lossy diagnostic before explicitly
approving loss; a rejected report immediately aborts only that job's staging.
`PreparedText::commit` binds the exact job and uses its single shared
prepare/apply operation, revision/target revalidation, cancellation/deadline,
asset cleanup and history. The source package remains recoverable on failure.
The caller supplies the existing enforced execution/asset ports. Native proof
uses prepared ports and real Session/MemoryStore/AssetWork; WASM is compile-only.
Platform watchdog, worker/process isolation, UI wiring and viewer support remain
with roadmaps31–36 and qualification37.

`validate_span` and `admit_adapter_spans` check adapter-owned byte/scalar/UTF-16
coordinates, overflow, UTF-8 boundaries, surrogate boundaries and declared lengths
before shared preparation. The mapper uses that same admission function. No
prefix commits on a later invalid run. Public offsets must fit u32; shared
fragment limits additionally bound 128 paragraphs and 1024 runs. Package scans,
mapping scans and output nodes share the ingress allowance; diagnostic overflow
rejects instead of returning a successful incomplete report.

Run `node tests/formats/run.mjs docx-import-text` with the locked toolchains.
The canonical receipt includes actual Rust tests, regressions, optional WASM
builds, graph checks, original generated input packages, semantic observations
and exact source pins. Compile tests are not WASM runtime or platform proof.

The optional `docx::export::PROFILE` implements the bounded
`docx-export-semantic-v1` direction. Start an export `PreparedJob` to capture
shared fragments and revision once, then call `docx::export::export` with a
restricted `OriginalAssetHost`. Preserve `Provenance::from_import` alongside the
original bytes after import; supplying different original bytes rejects. A newly
authored document uses empty original bytes and no provenance. Nonempty original
input without provenance requires explicit loss approval.

The report is reviewed before asset reads or output work. Registered marks whose
shared fragment API is unavailable refuse export. Unknown content, code semantics,
checklists/quotes, atomic list placement, inconsistent per-level numbering, image
alt/caption and retained import losses have explicit diagnostics. The supported
subset is pinned in `fixtures/formats/docx/export/profile.json`. Authorized PNG
reads use AssetWork, verified length/hash and the guarded decoder; cancellation
and errors retire only job-owned references. No URLs are fetched.

The writer's generated directory entries, empty properties, drawing IDs and
numbering defaults are normalized into the declared package vocabulary. Output
has fixed creation/modification metadata, A4 page size and explicit fonts/styles;
there is no Word layout, original package, macro or signature preservation claim.
Run `node tests/formats/run.mjs docx-export` for the real Session, independent
package/semantic inspection and declared macOS textutil reader fixtures. WASM
proof is compilation only; aggregate registry/platform/release gates stay closed.


## Captured PDF publication prerequisites

The optional `pdf-export` feature exposes `pdf::export::export_with_fonts` for
qualified text/rich/v1-table output and `export_with_assets` with an explicit
`OriginalAssetHost` for original PNG images. Both consume the existing immutable
`PreparedJob`, shared fragments, explicit pinned fonts and typed diagnostics.
The aggregate PDF profile remains unavailable pending isolated document execution
and full WCF-13/14/resource qualification. PDF import remains rejected.

Rectangular v1 tables have at most128 cells, equal-width columns, explicit
left/center/right alignment,6pt padding, semantic first-row column headers and
atomic row pagination. Empty cells and shaped-cluster wrapping preserve cell
text. Rows taller than a page refuse; headers are not fabricated on continuation
pages. V2/merged/nested cells and shared cell hard breaks remain unsupported.

Images require captured host identity, original length/digest/dimensions and
current read authorization through the Session asset journal. No source URL is
fetched. The PNG profile accepts static noninterlaced8-bit grayscale/RGB/alpha
with IHDR/IDAT/IEND only; ancillary profiles, animation, indexed/16-bit input and
other codecs refuse. Cumulative original bytes obey the job input limit and
decoded pixels are reserved before library allocation (1,048,576 total). Identical
originals share one read/decode; conflicting identity declarations refuse. Images
scale down within160x160pt and retain literal captions and Figure alternative
text. Output, timeout/cancellation and asset failures abort without live content
mutation and queue only job-owned cleanup.

`krilla/raster-images` is enabled only by this optional exporter. Its12 additional
locked package versions/notices are retained with C5 evidence; default registry
and minimum editor do not load converters, fonts or media. Prepared execution
ports and WASM compilation do not establish production process isolation,
platform support, PDF/UA, archival compliance or release qualification.

`odt-import` exposes `odt::import::{PROFILE, prepare, Prepared}` for the declared
ODF1.3 subset in `fixtures/formats/odt/profile.json`. It uses `container-codecs`
without docx-rs or PDF dependencies and returns one job-correlated prepared batch.
Original media enters the shared AssetWork service only after guarded validation;
unsupported features require explicit loss approval and retain original bytes.
The aggregate ODT registry remains unavailable until its consumer/platform gates.

## Bounded RTF import

Feature `rtf-import` exposes `rtf::import::{PROFILE, Budgets, prepare}`. See
[the exact grammar/profile](../../fixtures/formats/rtf/profile.md). It maps
Windows-1252/Unicode text, scoped marks, paragraphs and bounded rectangular text
tables to one shared prepared Session insertion. Unsupported destinations remain
inert with recoverable byte-offset reports; loss needs explicit approval. Font
selection/alternate encodings and unsafe/malformed table structures fail before
mutation. The caller retains original bytes. No parser dependency, OS control,
network or attachment capability is added; the disabled crate graph stays empty.
Run `node tests/formats/run.mjs rtf-import` for the canonical qualification.
Native execution ports are prepared and WASM is compile-only; export and platform
wiring qualify separately.

## Bounded captured RTF export

Enable `rtf-export` independently of `rtf-import`; call `rtf::export::export`
with a `PreparedJob` using that direction's `PROFILE`. The job captures shared
Session fragments once and returns an artifact labelled with that revision.
`approve_loss=false` rejects any lossy report; review all location-bearing
reports before explicitly allowing inert text fallbacks. When exporting retained
RTF input, pass `Provenance::from_import` and the identical original bytes in the
job to carry hash-correlated omission reports; missing provenance requires loss
approval. The caller retains original input. No live semantic state is changed.

The writer supports Unicode, four direct marks, paragraphs and rectangular v1
text tables, with explicit default font/color/code-page controls and escaped
literal control syntax. It neither fetches resources nor embeds fonts/objects.
See `fixtures/formats/rtf/export/profile.md` for budgets, unsupported constructs
and exact fidelity. Run `node tests/formats/run.mjs rtf-export` using locked
Node/Rust: real Session tests, independent macOS textutil output inspection and
negative mutations, WASM compilation, optional/default graph and native process
resource measurements. The OS reader is qualification tooling only. Platform
sandbox/wiring and release remain with roadmaps31–36/37.

`epub-import` exposes `epub::import::prepare` and its token-bound prepared commit
for the declared `fixtures/formats/epub/profile.md` reflowable EPUB3.3 subset.
It reuses guarded ZIP/XML, the shared inert HTML tree codec (parser disabled),
original PNG AssetWork staging and one Session insertion. Chapter/navigation and
source hashes are available in the report. Unsupported content requires explicit
loss approval and retains original input. No DOM, network, DRM/fixed-layout,
EPUB export, platform sandbox or release support is implied. Default dependencies
remain empty. Run `node tests/formats/run.mjs epub-import` with isolated evidence.

`epub-export` independently exposes `epub::export::export` and its `PROFILE` for
captured revisions. It produces the safe reflowable chapters/spine/navigation,
generated metadata, semantic XHTML and authorized original PNG profile documented
in `fixtures/formats/epub/export/profile.md`. Review complete loss diagnostics,
retain original input, and pass matching import `Provenance` when available.
`node tests/formats/run.mjs epub-export` runs actual Session tests and the
independent EbookLib/lxml output reader; explicitly set
`EDITAC_EPUB_READER_PYTHON` to the pre-provisioned pinned validation environment.
The default graph remains empty. WASM compilation and prepared native execution
are not platform sandbox, reader UI, pagination or release qualification.
