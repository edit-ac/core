# RTF import profile v1

Owner CNV-1.12. `edit-ac-rtf-v1`, import only, feature `rtf-import`.
This is an original bounded grammar implementation against Microsoft RTF 1.9.1
(March 2008), not an unrestricted RTF reader or operating-system rich-text control.
No third-party parser dependency, source, sample reader code, font or asset is
copied. Existing Apache-2.0 crate licensing applies to this implementation.

Primary references audited before implementation on 2026-10-17:
- [Microsoft RTF syntax](https://learn.microsoft.com/en-us/previous-versions/office/developer/office2000/aa140284(v=office.10))
- [Microsoft reference entry and official archive](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxrtfcp/85c0b884-a960-4d1a-874e-53eeee527ca6)
- Official archived `[MSFT-RTF].pdf`, pages 7–9 (tokens/groups), 14–16
  (scoped Unicode fallback), 93–96 (table grammar), 158–160 (binary pictures).
  The archive document retains Microsoft's copyright/license notices; it is
  consulted only, not redistributed with the adapter. Exact downloaded hash is in
  the qualification evidence. No specification license is presented as a license
  for any copied code, font or other implementation dependency.

Admitted grammar: one `{\rtf1 ...}` root, ANSI/Windows-1252 (default or explicit
`\ansicpg1252`), raw bytes and `\'hh`, signed 16-bit `\uN`, group-scoped `\ucN`
(0..16, default 1), UTF-16 surrogate pairs with matching marks, literal escaped
braces/backslashes, NBSP/nonbreaking/soft hyphens, named typographic punctuation.
Fallback counts raw/hex bytes, escaped symbols/control words as one, and `\binN`
plus its full payload as one; an unescaped group delimiter ends fallback. CR/LF
in the file are ignored. Undefined CP1252 bytes and malformed Unicode fail.
No normalization or replacement-character repair of authored text is performed.

Marks: bold, italic, single underline and strike with scoped resets, `\plain`.
Paragraphs: `\par`; interior LF `\line` and literal TAB `\tab` outside cells.
Other paragraph/style/layout/metadata controls are reported as unsupported.
A paragraph terminated by `\par` does not invent an additional final paragraph.
An empty source body yields one empty paragraph.

Tables: consecutive explicit `\trowd` rows, strictly increasing positive
`\cellxN` edges declared before content, `\intbl` single-paragraph cells,
`\cell` and `\row`, matching rectangular widths. Cell text/marks stay inert;
formula-like content is literal. A following `\pard` resumes ordinary text.
V1 shared table descriptors permit 32 columns, 128 rows and 1024 runs; their
existing validator is mandatory. Nested/merged tables, implicit/repeated row
properties and cell breaks/multiple paragraphs are explicitly unsupported and
fail atomically. Cell widths and pagination are not preserved. The declared
text-table interpretation has no imported exact-layout guarantee.

Font tables, default/explicit font selection and alternate code pages fail explicitly, avoiding an implicit
font-specific encoding guess. Style/color tables, OLE, pictures, fields,
headers/footers, revisions and other destinations stay inert; each omitted
outer destination/control has a byte-offset report. Unknown first controls and
`\*` destinations omit their complete group with diagnostics. Nested omitted
content remains covered by that recoverable source group, not partially mapped.
Unsupported inline controls are reported individually; accepting the supported
projection requires explicit loss approval. No execution/fetch/asset host exists.

Hard defaults: 1 MiB input, 4 MiB prepared representation, 4096 output nodes,
64 groups, 131072 lexical tokens, cumulative 64 KiB binary payload, 256 reports,
262144 output UTF-16 units. Smaller caller/job limits apply. Binary lengths,
control words (32 letters), numeric parameters (i32), all group work including
omitted destinations, nodes/runs/cells and actual output are checked during work.
Cancellation/deadline is checked on every token and before returning. Parsing
failure aborts this job only. Immutable original bytes/hash remain caller-held;
loss rejection aborts before a single shared Session insertion. Native transport
is prepared; WASM is a compile target. Platform isolation/wiring and release are
owned by roadmaps31–36/37. Export remains unavailable until CNV-1.13 qualifies.
