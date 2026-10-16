# Shared sanitized HTML import

`import` accepts bounded UTF-8 source with the native `parser` feature. It uses
HTML5 fragment repair without network or script execution. Browser builds disable
that feature and send inert template tokens to `import_tree_json`. Both paths use
one whitelist, URL admission, text-mark/container mapping, limits and diagnostics.
No host creates semantic blocks from HTML.

The result is prepared fragment data, never an edit or authority receipt. The
owning Session/engine must admit it against the current schema, content/asset
policy, retained destination, revision and permission before one atomic commit.
Callers retain the original bounded source for diagnostics and unsupported codec
recovery. Tables, images, SVG and other optional resources require explicit codecs;
this baseline never fetches them. NativeSession exposes the prepared result through
the existing generated `preparePaste`/`commitTransfer` boundary.
