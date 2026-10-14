# Built-in extension capabilities and parity obligations

This v1 matrix is a contract and evidence handoff. It is not a platform support announcement or package publication. The machine-readable [matrix](../../fixtures/extensions/capabilities.json) and [schema](../../fixtures/extensions/capabilities.schema.json) contain all 210 named cells, exact fixture IDs, requirements, platform gates, fallback behavior and hash-pinned evidence.

Run from core with the selected Node 24.19.0 toolchain:

```sh
node scripts/check-extension-capabilities.mjs
node --test tests/extension-capabilities.test.mjs
```

The canonical checker rejects incomplete coverage, invalid evidence, stale hashes, absent presenter fixtures/owners and fallback claimed as rich parity. No network, provider, credential or device access is needed. Regenerate this document after an approved matrix change with `node scripts/check-extension-capabilities.mjs --write-docs`. Schema versions describe the matrix, not persisted module data versions.

## Reading the matrix

Portable means current qualified data/codec fixtures, independent of OS delivery. Browser mechanics means the existing packed production Chromium/Firefox/WebKit prepared fixtures; real-device, native IME, OS clipboard and assistive-technology observations remain pending. Pending is an explicit platform-owner obligation, including pending fallback delivery. Fallback preserves inert data/source and never satisfies a richer view/edit/rendering parity claim. Document means ordinary document copy/export for transient slash/reorder controls, which have no stored module payload or separate codec.

Every fallback preserves bounded unknown identity/payload/source. No implicit lookup, asset fetch, code/formula execution, upload or permission grant is allowed. Plain/Markdown reference labels disclose identity loss and retain typed recovery; math source does not assert typesetting or dedicated transfer support. Rich formatting transfer remains EXT-1.13. Missing renderer/codec evidence cannot be inferred from a headless protocol trace.

## All host/module cells

Each row maps to `CAP-<module>-<host>-<capability>` in the JSON. All seven cells carry concrete acceptance behavior and owner gates. Rich parity requirements remain open where status is Pending. Accessibility stays Pending even when prepared browser tests assert roles/labels: those tests are not actual AT evidence.

| Module | Host | Preservation | View | Edit | Copy | Markdown | Accessibility | Rendering |
|---|---|---|---|---|---|---|---|---|
| slash | browser | Portable | Browser mechanics | Browser mechanics | Document | Document | Pending | Browser mechanics |
| slash | terminal | Portable | Pending | Pending | Document | Document | Pending | Pending |
| slash | swift-ios | Portable | Pending | Pending | Document | Document | Pending | Pending |
| slash | kotlin-android | Portable | Pending | Pending | Document | Document | Pending | Pending |
| slash | desktop | Portable | Pending | Pending | Document | Document | Pending | Pending |
| references | browser | Portable | Browser mechanics | Browser mechanics | Browser mechanics | Fallback | Pending | Browser mechanics |
| references | terminal | Portable | Pending | Pending | Pending | Fallback | Pending | Pending |
| references | swift-ios | Portable | Pending | Pending | Pending | Fallback | Pending | Pending |
| references | kotlin-android | Portable | Pending | Pending | Pending | Fallback | Pending | Pending |
| references | desktop | Portable | Pending | Pending | Pending | Fallback | Pending | Pending |
| reorder | browser | Portable | Browser mechanics | Browser mechanics | Document | Document | Pending | Browser mechanics |
| reorder | terminal | Portable | Pending | Pending | Document | Document | Pending | Pending |
| reorder | swift-ios | Portable | Pending | Pending | Document | Document | Pending | Pending |
| reorder | kotlin-android | Portable | Pending | Pending | Document | Document | Pending | Pending |
| reorder | desktop | Portable | Pending | Pending | Document | Document | Pending | Pending |
| images | browser | Portable | Browser mechanics | Fallback | Browser mechanics | Portable | Pending | Browser mechanics |
| images | terminal | Portable | Pending | Fallback | Pending | Portable | Pending | Pending |
| images | swift-ios | Portable | Pending | Fallback | Pending | Portable | Pending | Pending |
| images | kotlin-android | Portable | Pending | Fallback | Pending | Portable | Pending | Pending |
| images | desktop | Portable | Pending | Fallback | Pending | Portable | Pending | Pending |
| tables | browser | Portable | Browser mechanics | Browser mechanics | Browser mechanics | Portable | Pending | Browser mechanics |
| tables | terminal | Portable | Pending | Pending | Pending | Portable | Pending | Pending |
| tables | swift-ios | Portable | Pending | Pending | Pending | Portable | Pending | Pending |
| tables | kotlin-android | Portable | Pending | Pending | Pending | Portable | Pending | Pending |
| tables | desktop | Portable | Pending | Pending | Pending | Portable | Pending | Pending |
| math | browser | Portable | Browser mechanics | Fallback | Fallback | Fallback | Pending | Browser mechanics |
| math | terminal | Portable | Pending | Fallback | Fallback | Fallback | Pending | Pending |
| math | swift-ios | Portable | Pending | Fallback | Fallback | Fallback | Pending | Pending |
| math | kotlin-android | Portable | Pending | Fallback | Fallback | Fallback | Pending | Pending |
| math | desktop | Portable | Pending | Fallback | Fallback | Fallback | Pending | Pending |

## Keyboard, focus and scope

### slash

Only local eligible triggers open the menu. Arrow keys choose, Enter admits one registered command/history group, Escape cancels and restores editor focus. Composition, nested controls and remote patches never trigger it.

Fallback: Factory absent: no slash trigger, document editing remains.

Excluded or pending: native menu/focus/accessibility; remote edits must not open menu.

### references

Label and identifier remain inert offline. Keyboard explicit activation/query only through a host-granted resolver; Escape cancels. Retain engine anchors before menu focus; suppress revoked, stale or deleted-target results.

Fallback: Inert ID/label, no resolver call on opening.

Excluded or pending: inline reference authoring; lossless reference Markdown conversion; OS clipboard; catalog/authority integration (EXT-1.8).

### reorder

Every editable host exposes keyboard move up/down through the shared Move command, retaining identity and relative selection. Browser Alt+Arrow and focusable buttons restore editor focus; pointer handles are optional. Composition/nested controls take priority.

Fallback: Factory absent: reordered document remains readable.

Excluded or pending: native controls/drag qualification; separate copy/codec claim.

### images

Expose alt text and selectable inert source when no asset grant exists. No implicit upload or fetch. Source controls are nonediting; explicit host activation owns focus and permission. Authoring/resizing is not qualified.

Fallback: Alt/title/source retained; host asset policy required before URL activation.

Excluded or pending: authoring/resizing/upload UI; implicit asset fetch; OS clipboard.

### tables

Simple rectangular cell controls retain an engine target, use one atomic TableCell intent and undo group, and preserve navigation/selection. Nested cell composition owns temporary input. Unavailable controls expose nonediting exact source, never flatten cells.

Fallback: Exact edited tuple/source preserved without controls.

Excluded or pending: merged/spanned/rich/nested cell authoring; native clipboard/renderers; EXT-1.13 formatting transfer.

### math

Keep bounded LaTeX source selectable and labeled when renderer is absent, unsafe, invalid or failed. Optional preview never captures baseline input. No dedicated math authoring UI or inferred native typesetting parity.

Fallback: LaTeX source label; absent/failed/unsafe renderer preserves source.

Excluded or pending: dedicated authoring UI; math clipboard/Markdown conversion; native typesetting parity.

## Downstream owners and fixture use

- **browser**: [41-mobile-web-extensions.md](../../../architecture/roadmaps/41-mobile-web-extensions.md), gates `MWX-1.8`. Actual platform evidence: pending.
- **terminal**: [15-tui-client.md](../../../architecture/roadmaps/15-tui-client.md), gates `TUI-1.11`, `TUI-1.12`. Actual platform evidence: pending.
- **swift-ios**: [16-ios-sdk.md](../../../architecture/roadmaps/16-ios-sdk.md), gates `IOS-1.10`, `IOS-1.11`, `IOS-1.12`, `IOS-1.13`, `IOS-1.16`, `IOS-1.17`, `IOS-1.4`, `IOS-1.7`, `IOS-1.9`. Actual platform evidence: pending.
- **kotlin-android**: [17-android-sdk.md](../../../architecture/roadmaps/17-android-sdk.md), gates `AND-1.10`, `AND-1.11`, `AND-1.12`, `AND-1.13`, `AND-1.16`, `AND-1.17`, `AND-1.4`, `AND-1.7`, `AND-1.9`. Actual platform evidence: pending.
- **desktop**: [18-desktop-native.md](../../../architecture/roadmaps/18-desktop-native.md), gates `DSK-1.10`, `DSK-1.11`, `DSK-1.12`, `DSK-1.13`, `DSK-1.16`, `DSK-1.17`, `DSK-1.4`, `DSK-1.7`, `DSK-1.9`. Actual platform evidence: pending.

Each owner consumes the cell-specific `CAP-*` acceptance requirement and its linked `PRES-<host>-<obligation>` fixtures over the same atomic command, stable-selection, readonly, cancellation and disposal boundaries. Keyboard/focus behavior above applies before optional pointer/touch enhancements. Terminal source fallback is not a native table/image/math renderer; keyboard reorder remains a required pending action on every editable host. Browser ownership includes desktop browser mechanics plus mobile actual-device qualification.

The [presenter contract](../../../architecture/specs/extension-presenters.md) names the shared protocol and host resource ownership. The [built-in entry evidence](../../../architecture/evidence/extension-entry.md), [codec evidence](../../../architecture/evidence/extension-codecs.md) and [presenter evidence](../../../architecture/evidence/extension-presenters.md) retain exact implementation revisions and failed qualification history. Historical reference pre-clipboard receipts retain one failed clipboard case per engine (separately repaired upstream); historical math receipts retain one failed peer-source case per engine. Only individually passed named cases support the declared browser mechanics. The checker reports these aggregate failures and rejects failed/missing selected cases; it never treats the whole historical run as passing. Current unknown-data/codec/presenter receipt checks have zero required failures/skips.

The JSON evidence catalog binds each imported artifact and fixed corpus with SHA-256; only records linked from a cell support its claim. Future renderer/device receipts must be separately qualified by the named owners before changing status. Physical FMT-1.15 remains release-open.
