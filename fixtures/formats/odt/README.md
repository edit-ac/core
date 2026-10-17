# ODF 1.3 prepared semantic import

`profile.json` defines the directional `edit-ac-odt-v1` profile. `supported.xml`
is hand-authored local content, not an application-generated fidelity sample.
Tests construct standards-shaped original ZIP/mimetype/manifest packages around
it and retain their SHA256-named input files in the evidence directory.

The mapper preserves document order, UTF-16 text, the four supported inline
marks and safe links, decimal/bullet list structure, rectangular v1 rich-text
cells and paragraph-isolated original PNG assets through the existing Session
and AssetWork services. Formula-like strings remain literal. Styles are bounded
by family and parent chains; unsupported properties, fields, layout, wrappers,
metadata, signatures, active/remote content and omitted assets are diagnosed.
Unknown subtrees are inert and recoverable from the complete original job input.
All diagnostics require explicit `approve_loss` before commit. Encrypted content,
unsafe containers and exhausted budgets fail the whole job.

Run `node tests/formats/run.mjs odt-import` with the manifest's pinned toolchains.
The canonical suite includes actual native Session/history/reopen and scoped
cleanup checks, affected ingress/DOCX regressions, independent stdlib ZIP/XML
inspection with three negative mutations, native cold/warm process measurements,
optional WASM compilation and disabled-feature dependency checks. Execution and
asset transports are deterministic prepared ports. Browser/native platform
isolation and viewer wiring remain with roadmaps31–36; this profile supplies no
ODT export or suite-level fidelity claim and does not enable the aggregate host
registry direction.
