# RTF export profile v1

CNV-1.13, `edit-ac-rtf-v1`, optional `rtf-export`. Original Apache-2.0
implementation; no added codec/font dependency. Microsoft RTF 1.9.1 syntax,
Unicode and table vocabulary reuse CNV-1.12's pinned official reference audit.

Output is ASCII RTF1, ANSI/CP1252 header, uc1; every non-ASCII UTF-16 code unit
uses signed `uN?`, including both surrogate units. Literal braces/backslashes
are escaped; tab and line are controls. Ordinary ASCII cannot become a control.
Explicit Helvetica 12pt/black, auto background, no font embedding or lookup in
conversion. Reader substitution/layout is outside the semantic claim.
Four direct marks (bold/italic/underline/strike), paragraphs (including empty),
interior LF/TAB and rectangular v1 text tables up to32columns/128rows qualify.
Table cell breaks require a shared representation and fail rather than emulate.
Cell alignments, lists, heading/check styles, code/link marks and other atoms
produce complete location-bearing loss diagnostics. Unapproved loss fails;
approved loss uses the captured inert text fallback and never activates objects.
Private metadata, fields, OLE/macros and source-package layout are absent.
Provenance diagnostics are carried when supplied and hash-correlated; original
input without provenance requires explicit loss approval. Original bytes remain
in the immutable job source and are never embedded in output.

Hard ceilings:4MiB output,4096 semantic nodes,262144 UTF-16 units,256 reports;
smaller job limits apply. Output is charged before each growth and cancellation/
deadline before each scalar. Captured revision labels completion; no semantic
writes, asset reads, ambient network/filesystem or conversion-time font work.
Native real Session tests use prepared execution ports; WASM compile only.
Independent generated-artifact inspection uses macOS textutil, outside runtime.
No source byte/layout identity, font appearance, native sandbox/platform wiring,
release or import/export symmetry claim. Import profile remains independent.
