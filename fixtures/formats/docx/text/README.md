# DOCX text profile fixtures

These original XML fixtures are packaged in memory by `docx_import_text.rs` with
an explicit OPC main relationship/content type and optional style/hyperlink
relationships. ZIP output is stored under the scenario receipt's `inputs/` by
SHA-256, including adversarial variants. No private documents or Wordcraft assets
are used. Dependencies remain the previously reviewed exact optional stack.

- `supported.xml`: paragraphs, astral/combining/CJK text, whitespace/entities,
  direct mark overrides, inherited heading and marks, link, tab, two break forms,
  and an empty paragraph. `styles.xml` supplies default/inherited/toggle controls.
- `unsupported.xml`: layout/theme properties, revisions, content control,
  simple/complex fields, foreign namespace and table/section constructs. The
  semantic oracle excludes unsupported branches and keeps recovery diagnostics.
- Generated test variants: namespace aliases, malformed/unknown roots, duplicate
  singletons/styles, style cycle/reference failures, unsafe/missing hyperlinks,
  alternate branches, script-specific marks, budget/control failures and scoped
  staging cleanup. No network effect is available to the parser.

WCF-09 uses `a🙂éz` with byte/scalar/UTF-16 spans. Separate executed tests reject
split UTF-8 starts/ends, split surrogate starts/ends, checked-add overflow,
length disagreement and out-of-range spans in all three systems. Valid controls
preserve astral and combining neighbors, including a combining-only substring,
and check returned UTF-16 coordinates plus real Session stable anchors. A later
invalid run rejects the complete multi-paragraph batch. These cases use the
same span admission as the DOCX mapper, without a panic-recovery admission path.
