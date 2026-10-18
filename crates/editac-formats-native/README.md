# Optional standalone native format consumer

This unpublished, independent workspace consumes the public `editac-formats`,
`editac-core` and `editac-session` APIs. It does not enter the minimum editor graph.
`runner.py` exposes `run(binary, binary_sha256, original, *, wall_ms=4000,
output_bytes=4194304, cancel=None)`. The reviewed binary hash is host configuration;
never derive an executable or a hash from document content. Import requires an
available macOS arm64 sandbox. Missing isolation, binary mismatch or unsupported
resource profiles return typed unavailable outcomes without unrestricted fallback.

The result retains `original` as bytes on every outcome. `outcome` contains the
correlated input hash, diagnostics, counts and costs. Successful `result.checkpoint`
is a new shared Session checkpoint; it is not journal durability or permission to
replace a host document. Host insertion and platform wiring are outside this profile.
Unsupported RTF constructs return the full recoverable diagnostic report. There is
no implicit lossy approval. PDF input is rejected by the shared export-only policy.
The separately qualified RTF export route is described below; other native
formats/directions except the table import route below remain unqualified by this package.

The runner installs deny-default filesystem, network and process policy before
conversion. Only the pinned executable, OS loader paths and inherited bounded
stdin/stdout/stderr are available. It grants no source directory, user document,
font, output-directory or network authority. The binary reads at most 1MiB from
stdin; a 4MiB complete JSON/checkpoint output ceiling never truncates a success.
One active public call per runner process is allowed; others return `FORMAT_BUSY`.
The runner has a wall/cancellation watchdog, hard CPU/output/FD/core limits and a
256MiB **sampled** process RSS watchdog. Failed/late/partial results are discarded,
the exact child is reaped and temporary output is deleted. Originals stay with the
caller on cancellation, abort, deadline, unavailable enforcement or output failure.

The binary installs a 64MiB ceiling on concurrent requested Rust heap bytes through
its global allocator before main. Every allocation/zero-allocation/reallocation is
charged before allocation; failed growth rolls back, deallocation and successful
shrink release capacity. Exhaustion aborts this isolated child. This bound includes
all Rust dependencies in this RTF binary. It excludes allocator metadata, runtime
mappings, stack and non-Rust allocations; the whole process has **no hard memory
cap**. RSS measurements and maximum sample interval are reported separately.
`ExecutionPort.hard_memory_bytes` describes this actual Rust heap boundary, not a
prepared fixture or an inference from sampled RSS. The runner is its trusted host
watchdog; do not invoke the private worker as a public unrestricted converter.

The `qualification` feature adds attack probes only. Production builds omit these
commands. Source-package tests compile both variants outside the checkout, pin
all local source members, locked dependencies, binary and license/notice bytes,
and test the production binary for actual Session/history/reopen behavior. No
registry publication, OS editor/viewer wiring, paid service or release is claimed.

`run_export(binary, binary_sha256, checkpoint_request, *, wall_ms=4000,
output_bytes=4194304, cancel=None)` accepts bounded UTF-8 JSON containing
`documentId`, `epoch`, `writerId`, `checkpoint` (initialized checkpoint bytes) and
`checkpointSha256`. Import results expose these fields for explicit subsequent
export. The shared store validates and reopens that exact checkpoint; the writer
captures one Session revision. `outcome.result` returns complete RTF artifact
bytes, their hash, captured revision, source checkpoint hash, representability
report and unchanged-Session/reopen evidence. `Result.original` retains the exact
request envelope on success and every failure. The checkpoint is the recoverable
source; source-package layout or external authoring provenance is not inferred.

Loss is refused unless the caller explicitly sets `approveLoss: true` in the
request; complete diagnostics remain visible with approval. The qualified text,
direct bold/italic/underline/strike, paragraph and simple-table subset uses the
existing bounded writer. Unsupported block styles, marks and atoms are reported;
no image/remote asset read or active RTF destination is granted. `outputLimit`
may reduce the writer output budget. The qualification build accepts `laterText` to exercise a private Session
mutation after capture; production rejects that test-only option. Concurrent
caller buffer changes cannot alter the admitted bytes.
Neither completion nor `reopen` acknowledges a host save or durable journal.

The qualification build also supplies `export-fixture`, which prepares controlled
shared Session checkpoints through the existing fragment/job API. Production
builds omit this command. Independent macOS `textutil` and a separate HTML semantic
oracle inspect only generated artifacts outside the conversion sandbox. Native
RTF profiles use declared writer defaults and no bundled fonts or media assets.

`run_table(binary, binary_sha256, original, *, dialect, wall_ms=4000,
output_bytes=4194304, cancel=None)` imports CSV/TSV through the qualified strict
text-table mapper. `dialect` requires exactly seven fields: `delimiter`
(`comma`/`tab`), `quote` (`double`), `escape` (`double`), `encoding`
(`utf8`/`utf8-bom`), `newline` (`lf`/`crlf`), `header` (`none`/`first-row`),
and `ragged` (`reject`). There is no detection or implicit type/formula evaluation.
The selected delimiter fixes the direction/profile; unsupported choices fail before
process startup. Header rows remain content and receive explicit cell flags.
The profile allows at most128 rows,32 columns,1024 cells,8192 UTF-16 units per cell
and262144 units total, subject also to the shared input/output/job limits.
Quoted LF is preserved; CR inside a cell is recoverably unsupported by the shared
descriptor. Malformed quoting, newlines, ragged rows, invalid UTF-8/BOM policy and
resource exhaustion reject without returning a partial committed document.

The new Session checkpoint includes exact inert table source (without the optional
encoding BOM), rich-table cell/header semantics, and history. Complete original
bytes including BOM remain in `Result.original` on every outcome; hosts must retain
those bytes alongside their checkpoint under their retention policy. Checkpoint
reopen alone is not a promise of original file byte recovery. Success reports
exact scanned bytes/dimensions/UTF-16 units/BOM handling. The runner validates
profile/input/dialect/checkpoint/report correlation before returning completion.
Cold/warm measurements include process bootstrap, sandbox, parse, mapping, commit,
undo/redo, reopen, checkpoint and result transfer. Codec notices are in the native
source-package receipt; this import route has no fonts/media assets. Native host
wiring and release remain separate unfinished gates.

Selected-table export: `runner.run_table_export(binary, reviewed_sha256, request_bytes)`
accepts the initialized checkpoint envelope with an explicit `selectedTable` block
ID, `profile` (`edit-ac-csv-v1`, `edit-ac-tsv-v1`, or separately named
`edit-ac-{csv,tsv}-spreadsheet-safe-v1`), and `newline` (`lf`/`crlf`).
UTF-8 without BOM, all fields quoted with doubled quotes, a final newline and
all rows retained are fixed policies. Rich-format loss requires `approveLoss: true`.
Spreadsheet-safe profiles prefix dangerous text and report each transform; exact
profiles preserve formula-like strings. Missing selections reject and outside
content has diagnostics. Retain Result.original (checkpoint envelope) for recovery.
Output completion never marks a host revision saved. Native UI, file saves,
independent viewer qualification and release support remain platform-owner gates.


ODF1.3 export is an independent optional native build: `cargo build --locked
--offline --features odt-export --manifest-path crates/editac-formats-native/Cargo.toml`.
`runner.run_odt_export(binary, reviewed_sha256, request_bytes)` accepts the same
initialized checkpoint envelope, explicit `profile: "edit-ac-odt-v1"` and optional
`approveLoss`. The trusted caller may add `approvedAssets`, at most64 records
`{host,key,bytes}` granting read access to those exact local originals. A document
asset descriptor is never a grant. No path, URL, network or ambient asset lookup
is accepted. Missing grants/read failures/hash or media mismatches reject the
whole output and preserve the checkpoint request. Keep `Result.original` under
the caller's retention policy; it includes explicitly supplied approved bytes.
The shared ODT writer and AssetWork authorization produce the artifact; no new
semantic serializer or persistence model is introduced. Fixed captured revision,
complete loss reports, original PNGs, local schema/independent reader validation,
resource enforcement and cold/repeat costs qualify this native adapter only.
Other directions, OS viewer/UI/save integration and release remain independent.
The default native build excludes the ODT ZIP/XML codecs; all codecs/fonts remain
absent from the minimum editor and disabled formats graph.

### ODT import prerequisite

Build with optional `odt-import`. `run_odt_import(binary, binary_sha256,
original, *, approve_loss=False, wall_ms=4000, output_bytes=4194304, cancel=None)`
imports the qualified ODF1.3 text, marks, nested lists and v1 table subset into a
new in-memory shared Session. The same native sandbox/resource launcher authenticates
the executable and correlates the complete checkpoint/result. Lossy constructs
require explicit approval and retain complete diagnostics. Keep `Result.original`
under host retention policy for every outcome; a CRDT checkpoint is not the original
ODT package. No live host document, save state or journal durability is implied.

**Media-bearing ODT is unavailable on this native route.** After guarded mapping,
it returns `FORMAT_NATIVE_ASSET_ADOPTION_UNAVAILABLE`, no content commit, complete
diagnostics and exact original-media candidates. These candidates are recovery
output, not adopted/live asset references. The complete source remains in
`Result.original`. Shared native `PreparedJob::finish_import` currently commits
content without atomically adopting prepared originals; browser storage proof does
not establish this native contract. The shared owner must supply that boundary
before full native ODT import can be qualified. No lossy approval bypasses it.

`consumers-native-odt-import-text` qualifies only this prerequisite. It cannot close
N-OI, the complete native/profile/target matrix or downstream platform/release gates.

### Optional native DOCX export

Build with `--features docx-export` and call `runner.run_docx_export` with the
reviewed executable hash and a serialized initialized Session checkpoint request.
The explicit `edit-ac-docx-v1` profile accepts caller-approved `{host,key,bytes}`
originals independently of document metadata. The sandbox denies ambient files,
network and child processes. Missing grants reject; there is no remote fallback.
The writer reports package/page/metadata defaults and unsupported image alt/caption
or code-mark fidelity. Loss requires explicit `approveLoss: true`. Keep the exact
`Result.original` envelope (checkpoint plus approved originals) for recovery on
every outcome. Completion identifies the captured revision and never marks a
host document saved. Qualification uses immutable local source packages, actual
Session/job/AssetWork conversion, independent generated-package/textutil checks
and complete caller costs; this adds no native host UI, Word layout, crash
durability, platform support or release claim.
