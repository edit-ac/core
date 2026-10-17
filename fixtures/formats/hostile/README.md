# Guarded OPC fixture profile

`cases.json` pins the CNV-1.4/WCF-06/07 matrix. The canonical actual fixtures are
constructed by `crates/editac-formats/tests/container_limits.rs`: a minimal classic
ZIP writer intentionally permits duplicate entries and metadata/CRC corruption,
while the selected ZIP writer constructs an actual compressed bomb. This avoids
large committed hostile payloads and prevents a friendly writer from silently
repairing malformed fixtures. Entry/relationship permutations run in both orders.
The existing hand-authored DOCX and original tiny PNG are also passed through the
real guard. PNG chunk/zlib fixtures test actual scanline expansion with bounded
scratch storage, not only claimed header dimensions.

Tests reuse `tests/support/jobs_harness.rs` with the job suite, MemoryStore/Session,
real AssetWork intents, deterministic enforcement/asset ports and explicit scoped
cleanup. The PNG validator and package guard have no network or filesystem port.
No private files, live credentials, external resources or provider calls are used.

The qualified profile is intentionally explicit: default ceilings are 1 MiB input,
256 entries, 2 MiB per part/aggregate inflation, 100:1 actual inflation ratio,
64 XML levels/attributes per element, 2 MiB cumulative text/attributes, 4096
XML/output nodes and resource references, 32 MiB cumulative scanned work,
16,777,216 pixels and 64 MiB RGBA reservation. Requests may only tighten limits.
The one-byte ZIP/scanline exhaustion sentinel is observed in failed work receipts;
it never enters a successful part or raster. Only the stated PNG profile is
admitted; other media stays explicitly unsupported and recoverable.
