# Optional standalone native RTF consumer

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
formats/directions remain unqualified by this package.

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
