# Selected text-table import v1 (CNV-1.16)

Select CSV comma or quoted TSV tab; no sniffing. UTF-8 strict or explicitly
UTF-8 with optional leading BOM. Double-quote fields, doubled-quote escape,
no backslash escape, comments, trimming, type inference or formula evaluation.
Choose LF or CRLF record terminators. Quoted cells admit literal LF; CR inside
cells is rejected as SHARED_CELL_CR_UNSUPPORTED because shared table descriptors
cannot retain it. No CR normalization or flattening occurs; original input stays
recoverable. Empty physical records reject (quote an empty one-cell row as "").
Final record terminator is optional. Malformed quotes and wrong line endings reject.
Header choice is first-row or none, with every row retained and explicit v2
header flags. Ragged rows reject; no padding or truncation. Blank cells, whitespace,
Unicode, literal tabs/newlines and formula-like strings remain exact inert text.

Hard maxima: 1 MiB input; 128 rows; 32 columns; 1024 cells/runs; 8192 UTF-16
units per cell and 262144 aggregate; 4096 job nodes and 4 MiB prepared output.
Callers may only lower limits. Scan/decode check job cancellation/deadline;
parse, descriptor or admission failure aborts only the current job.

Codec qualification before pin: csv-core0.1.13, rust-csv1.4.0 upstream,
Unlicense OR MIT, no default features, memchr only. Reader::read_field uses
caller-bounded output buffers and no_std finite-state parsing. Upstream is
intentionally permissive; a strict bounded vocabulary guard precedes decoding.
The guard is not an independent fidelity oracle; exact cells are tested against
hand-authored expectations plus Python stdlib csv reference outputs.
Primary sources (reviewed 2026-10-18):
https://github.com/BurntSushi/rust-csv/tree/1.4.0/csv-core
https://docs.rs/csv-core/0.1.13/csv_core/struct.Reader.html
https://www.rfc-editor.org/rfc/rfc4180 (comma/CRLF baseline; quoted TSV and LF
are separately selected explicit dialects). Native and wasm32 compile/runtime
scope and dependency notices are recorded with the delivery receipt. No platform
isolation, spreadsheet workbook, export, native host or release claim.
