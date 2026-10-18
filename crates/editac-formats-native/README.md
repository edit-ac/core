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
All other native formats/directions remain unqualified by this package.

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
