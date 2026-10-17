# Optional semantic ODF 1.3 output fixture

This profile is independently directional. Runtime dependencies reuse exact ZIP
8.6.0 (MIT), quick-xml 0.41.0 (MIT), flate2 1.1.10 (MIT/Apache-2.0), and the
existing shared Session/assets. See the import qualification dependency/notice
inventory in `architecture/evidence/document-conversion/odt-import-20261017`.
No DOCX/PDF runtime, reader, font or network dependency is added.

`schema/` contains unmodified OASIS ODF 1.3 standard schemas downloaded explicitly
for output validation from https://docs.oasis-open.org/office/OpenDocument/v1.3/os/schemas/.
Original OASIS copyright/IPR headers are retained. These schemas are validation
fixtures, never runtime assets. OASIS specification notices and permitted schema
use are at https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part1-introduction/OpenDocument-v1.3-os-part1-introduction.html.

The independent oracle requires an explicitly provisioned offline Python
interpreter with odfpy 1.4.1 (Apache-2.0), defusedxml 0.7.1 (PSF), and lxml 6.0.2
(BSD; bundled libxml2/libxslt notices apply). Set `EDITAC_ODT_READER_PYTHON` to that
interpreter. Tests never install packages or fetch schemas. Validation dependencies
are excluded from the Rust dependency graph. The canonical suite writes actual
packages and six negative mutations; official RNG checks and odfpy inspection do
not invoke edit.ac's importer. It qualifies semantic output, without a desktop
viewer, arbitrary pagination, platform sandbox, or release claim.
