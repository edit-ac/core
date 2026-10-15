# Generated Session command and history proof

This NCB-1.3 consumer composes the unchanged canonical `session-probe/main.swift`
and `RichCases.swift` with `CommandCases.swift`. It uses the authoritative
`crates/editac-ffi/generated` bindings, actual `libeditac_ffi.dylib`, and real
SQLite Session stores. It does not translate commands or implement editor/history
semantics. `run.py` retains the canonical harness's measured generated-source
buffer/free sites and unchanged legacy ABI consumer. `session-backward.py`
separately tests the prior admitted generated Session consumer without rebuilding
its declarations from current metadata.

From core, with isolated output:

```sh
python3 tests/native/bounded-bindings.py --output .artifacts/ncb-1.3-20261015
EDITAC_NATIVE_SESSION_EVIDENCE="$PWD/.artifacts/ncb-1.3-20261015/fixture" \
  cargo +1.97.1 run -p editac-ffi --example session_rich_fixture --locked
python3 tests/native/session-command-proof/run.py \
  --output .artifacts/ncb-1.3-20261015 \
  --rich-fixture /absolute/path/from/fixture-writer/manifest.json \
  --fixture-writer target/debug/examples/session_rich_fixture
python3 tests/native/session-backward.py \
  --output .artifacts/ncb-1.3-20261015/backward
python3 tests/native/session-command-proof/impact.py \
  --output .artifacts/ncb-1.3-20261015/entry-impact.json
```

The `--case` option reruns repaired/new normal cases while the measured build
still executes the full combined suite; filtered cases are not represented as
new normal passes. `--reuse-legacy` accepts only exact matching library,
generated artifacts and legacy source/fixture hashes. Keep failed attempt
receipts and logs. All actual runtime counts and consumed artifact hashes are in
per-attempt receipts; `impact.py` is an applicability audit, not runtime proof.

The cases exercise split/join/move/format/list, authoritative catalog/profile
limitations, captured UTF16 Unicode/bidi targets, actual history transitions,
permission/revision rechecks, bounded plan cancellation and ownership, serialized
commit/disposal, and retained-update SQLite recovery. Default tables and optional
host presenter/resolver/asset/search/code services remain explicitly unavailable.
Clipboard services stay host-owned. This is local macOS arm64 boundary proof;
AppKit input/platform/release and original DSK-1.7 require their own acceptance.
