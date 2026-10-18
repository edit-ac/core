# Selected table text export v1 (CNV-1.17)

Public optional `table-text-export` consumes the shared immutable Session job capture.
Caller selects one captured block ID; absent, foreign, non-table and ambiguous
whole-document targets fail. Every excluded visible node appears in the report.
Both canonical v1 and v2 descriptors are validated by the shared content admission.
Merged cells and multiple paragraphs per cell reject even with loss approval.
Rich marks, paragraph styles, alignments and header flags (including the implicit
v1 first-row header) require explicit loss
approval and location diagnostics. Header text stays in its original row. The
original source and recovery remain retained; they are not exported as cell data.

Exact profiles edit-ac-csv-v1 and edit-ac-tsv-v1 write UTF-8 without BOM, selected
LF or CRLF record endings including the final ending, every field double-quoted,
and doubled embedded quotes. All cell text, literal LF, empty cells, whitespace,
Unicode and formula-like strings stay exact. No dates, types or formula evaluation.
Hard bounds:128 rows/32 columns/1024 cells/8192 UTF-16 per cell/262144 total,
4096 work nodes/4 MiB output; job callers may lower limits. No truncation.

Separate edit-ac-csv-spreadsheet-safe-v1 and edit-ac-tsv-spreadsheet-safe-v1 profiles
prepend one ASCII apostrophe to cells starting with =,+,-,@ after leading Unicode
whitespace/control, or starting with TAB/CR/LF. Every changed cell has a
SPREADSHEET_SAFE_PREFIX diagnostic. Selecting that profile explicitly chooses the
transform; rich-format loss still requires approval. It is a declared text
transform, not universal protection across spreadsheet applications. Apostrophes
already present are retained. Exact output is never silently transformed.

Writer uses no new codec or runtime dependency; escaping is bounded serialization
of the already-qualified dialect, independently read and regenerated using Python
stdlib csv. Import's csv-core0.1.13 remains optional and is absent from export-only
and disabled graphs. No network, formula engine, browser/platform isolation,
spreadsheet workbook or release claim.
