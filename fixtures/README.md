# Semantic input fixtures

FND-1.2 supplies schema-neutral input recipes for later real-engine probes.
No file here is a Yrs document, a serialized update or an adopted editor schema.

Use the pinned Node 24.19.0 runtime:

```sh
node fixtures/generate.mjs /tmp/editac-fixture-output
node --test tests/fixtures.test.mjs
```

The CLI requires an explicit destination. It writes five JSON recipes, four
UTF-8 text files and a manifest. Generated corpora are reproducible; only the
generator and compact expected manifest are committed. Tests generate twice in
isolated temporary directories and remove those directories in `finally`.
`npm run check:fixtures` runs the named suite and is included in `npm run check`.

Seed `0x5eed1234` uses a specified 32-bit LCG (multiplier 1664525, increment
1013904223). There are no clocks, random system inputs or external transports.
IDs, traversal order and UTF-8 JSON encoding (one trailing newline) are fixed.
The manifest pins SHA-256 hashes and semantic shape expectations. A generator
change must be reviewed together with any changed expected manifest.

| Recipe | Input contract |
| --- | --- |
| Task | 20 top-level blocks; 10,240 text bytes |
| Long | 2,000 mixed top-level blocks; 1,048,576 text bytes |
| Large | 10,000 mixed top-level blocks; 5,242,880 text bytes |
| Aged | Long base plus 100,000 seeded insert/delete operations |
| Adversarial | 250 KiB paragraph, 1,024 alternating marks, Unicode, nesting and wide table |

Mixed blocks are paragraphs, headings, list items, code, quotes and tables.
Table rows/cells contain text leaves. Text files concatenate depth-first leaf
text without separators; boundaries and attributes are retained in JSON recipes.
Text byte counts exclude JSON, attributes, delimiters and operation payloads.
`inputRecipeBytes` counts JSON input, while `serializedCrdtBytes` and its hash
are `null` until measured by a real engine. Zero would be a false measurement.

Aged operations target the first text leaf of a block (the first table cell for
tables), use UTF-16 offsets and preserve the base content after each insert/delete
pair. This churn recipe can create CRDT history/tombstones only when a real engine
applies it. The string-only test oracle checks operation validity and expected
content; it does not establish an aged engine state, anchors or update size.

Unicode cases specify original strings, replacement ranges, expected text,
grapheme boundaries, invalid surrogate-interior offsets and anchor expectations.
Emoji, ZWJ, combining marks, RTL, flags, skin tones, variation selectors and CRLF
are separate cases. Engine anchor results remain `null`. Rejection and anchor
expectations are inputs for later engine tests, not proof of engine behavior.

Nested inputs have tree depths 31, 32 and 33. The boundary of 32 is a fixture
parameter; no production admission limit is qualified here. The wide table has
4 rows and 128 columns. Multi-editor scenarios reference Task with 50 static
previews and separately 1 or 10 active editors, without runtime or performance
claims. Large and Aged remain diagnostic inputs until separately qualified.
