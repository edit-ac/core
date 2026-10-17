# Optional local format boundary

CNV-1.1 delivers a capability contract, import admission and a bounded complete
output builder. It installs no converter, font, network transport or filesystem
writer. All seven new format records remain `planned-unavailable`; import and
export qualification are separate. The crate is an independent Cargo workspace
to avoid changing the common owner's workspace manifest/lock or the minimum
editor graph. It has no runtime dependencies. Its only test dependency is the
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
