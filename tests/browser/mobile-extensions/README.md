# Mobile extension admission harness

Run from core with the repository's Node/npm toolchain:

```sh
npm run build
npm run test:mobile-extensions -- --group capabilities
npm run test:mobile-extensions -- --group menus
npm run test:mobile-extensions -- --group content-controls
npm run test:mobile-extensions -- --group formats
node --test tests/consumers/mobile-extensions/disabled.test.mjs
```

Set absolute worktree-owned `EDITAC_MOBILE_EXTENSIONS_OUTPUT` and
`EDITAC_MOBILE_DISABLED_OUTPUT` directories to retain package tarballs, source
pins, per-case browser observations, emitted bundle graph and raw failures.
The dispatcher rejects unknown/unimplemented groups, zero browser execution,
skips, changed source and incomplete teardown. The graph check deliberately
fails when optional implementations remain in the minimal packed consumer.
Passing browser cases alone cannot close MEX-1.1.

The 32-case index pins original catalog text and owners. Each later parent adds
its executable mechanics; pending index entries are not passing observations.
The configured profile cases use the current extension facade. Advanced legacy
code/table/reorder/slash/reference rows retain compatibility coverage separately.
Required resources are counted by the existing mobile harness; optional allocation
stacks and explicit emitted byte contributions are recorded separately. Prepared
share rejection/absence capability tests exercise the existing baseline fallback
port. The formats group separately runs the production optional format presenter,
real Session/Markdown/IndexedDB, prepared OS transports and exact-byte browser
downloads. Qualified document-format cells use the pinned optional worker; these checks do not close
MEX-1.6. Platform, actual OS input/AT, performance and release
qualification remain in the original owning gates.


The command admission matrix enumerates the installed first-party registry, all
15 portable command IDs and their aliases, 45 action labels across code,
reorder, table, search and slash presenters, the eight table-cell selectors,
reference insertion controls, and the seven image/file/embed actions. Each row
records availability, configuration, authorization and qualification separately.
The inventory is evidence input, not a second dispatcher or authority registry.
Exact DOM labels and owning resource/semantic snapshots detect inventory drift.

`command-matrix.ts` covers editable/read-only/denied/unknown/stale and remote
admission using actual presenters, plus the versioned reference host. The content
host matrix tests absent/denied/unknown/rejected/read-only ports and inert remote
updates. It checks source bytes in the engine separately from the browser's
normalized textarea display. Unknown envelopes retain their generic source-only
fallback; known embeds must reach their owning inert card before that fallback.
No prepared fallback result establishes actual file, share, capture or OS delivery.

The optional `formatControls({loadProfiles})` metadata port loads only when the
user invokes **Show installed format profiles**. The host authenticates the
installed package and its direction-specific proof, bounds the local metadata
transport, and honors the supplied abort signal. It returns `{provenance,
manifest}`; the presenter validates all browser rows before displaying any.
Native rows are excluded, duplicate/invalid directions fail closed, and PDF
import is always rejected. A catalog row grants no conversion or asset authority.
Without `loadClient`, the selectors expose only connected text/Markdown actions.
A host may supply `loadClient(signal)` from the same authenticated package's
`createFormatClient()`. After the explicit profile action, selectors advertise
those exact browser directions/profile/fidelity labels, including PDF export
only. Client loading and conversion begin only on explicit preparation. The
controls own cancellation/disposal, including late client loads. CSV/TSV use an
explicit line-ending/header dialect and chosen table. Reported losses require
explicit approval. Import previews confirm through the existing Session commit
path; embedded originals require the existing asset adoption owner and are not
admitted as ordinary fragments. Binary artifacts retain bytes for download/save;
text clipboard/manual copy is offered only for text representations. The menu cases are prerequisites; the integrated formats group also exercises
the original adoption and captured export/share lifecycle described below. Cancellation, dismissal and
disposal fence late catalog results, and metadata failure preserves baseline
recovery. The formats harness authenticates the qualified canonical2 package
hash and owner ancestry before installing its actual entry and manifest. It
tests the catalog separately from conversion and actual OS delivery.

The fixture rejects external requests, window opening, permission probes and
capture. Hosts are hand-authored callbacks; no credentials or providers are used.
Baseline resources and optional listener ownership are checked separately after
disposal. Current Code/Pairs registry contract-fixture status is preserved, and
future mobile format/assistance/formatting adapters remain in their own parents;
these tests do not admit them or close platform/performance/release predicates.

The disabled graph guard checks every emitted contribution, including lazy chunks,
for both the native-minimal and public-default bundle entries. Eager-import
absence alone is insufficient. Real optional-module counterfactual bundles must
fail both guards. Enabled native ESM consumers use package-relative presenter
URLs; bundled hosts use the existing asset manifest/base URL. Presenter manifest
keys are `searchModule`, `reorderModule`, `slashModule`, `referencesModule` and
`contentModule`; math uses `mathModule`. Managed highlighting uses
`highlightModule` and `highlightTransport` alongside its worker/backend URLs. This is host configuration, never content.
View/request IDs remain unique across legacy bundled and separately loaded
presenters without a shared global counter or document-state mutation.
The installed loading consumer supplies and exercises these URLs separately from
the minimal consumer, which emits and requests none of those optional artifacts.

The `menus` group exercises MWX-C05–C08 with the same packed production
BrowserEditor/Session/WASM/IndexedDB harness. Intrinsic 44 CSS px action targets
are measured without the fixture's button sizing. Prepared viewport geometry
covers keyboard-sized layouts, rotation, magnification and floating occlusion;
actual OS selection menus, pinch gestures, IME and AT remain unqualified here.
The owning command, reference lookup, private reference display and link activation
ports retain all selection/history, cancellation and permission decisions. Preview
and navigation hosts are deterministic callbacks; no external requests are allowed.
`EDITAC_MOBILE_EXTENSIONS_BROWSER` selects Chromium, Firefox or WebKit. Firefox
uses a desktop viewport with touch enabled because Playwright does not support
its `isMobile` option. Every result keeps that provenance and source/package hashes.

Content-controls covers packed touch code/search/table actions, target layout,
prepared highlight fallback, range selection and table presenter invalidation.
It does not prove selected Markdown source formatting: the existing Rust
SourceBaseline formatter has no packed browser API. That MWX-C12 criterion and
MEX-1.3 stay open until the shared owner supplies a qualified boundary.
Language/copy controls are not advertised by the current code-command profile.
Native selection/scroll/zoom observations remain pending MWX-1.8.

Gestures (`--group gestures`) reuses the packed production reorder owner and
BrowserEditor/Session/WASM/IndexedDB. MWX-C13–C16 cover intrinsic touch targets,
selection-preserving tap/drag/undo, nested auto-scroll, terminal/capture cleanup,
viewport disruption and stable remote targets. Image/table inventories explicitly
advertise no portable resize command; no new dimension field is introduced.
Prepared mobile geometry and pointer events remain separate from real
MWX-1.8 device/native scroll, zoom, IME and accessibility qualification.

Asset/embed prerequisite integration:

```sh
npm run test:mobile-extensions -- --group assets
```

The assets suite consumes installed production BrowserEditor, Session, WASM and
IndexedDB with prepared image/attachment/embed hosts. `contentModules` accepts
`imageLoading: 'explicit'` to show a source/alt-text card and Load image action
without resolving or fetching on mount. The compatibility default remains
`automatic` for hosts already supplying an image policy. Image/file cancellation
and embed deactivation release presenter-owned work; embedding requires a fresh
explicit authority check. These controls use intrinsic 44 CSS pixel targets and
bounded source views. Prepared host responses and viewport changes are mechanics
checks, with actual picker/camera/clipboard/device behavior still unqualified.

Passing this suite does **not** close MEX-1.5: MWX-C17 file-input/capture and
MWX-C18 binary ingestion/upload/background lifecycle require an exposed owning
AssetWork browser adapter. Existing resolve-url/open/download ports cannot ingest.
The mixed-file clipboard rows qualify existing HTML/plain precedence and recovery,
not insertion of binary bytes or durable upload. Do not add a second journal or
serializer to replace the missing Session boundary. Preserve its admission receipt
and retry only when a qualified pinned owner return changes that prerequisite.


`formatControls({authorizeImport})` also supports explicit host-approved embedded
originals. The callback returns hash-bound import grants, a separate source-package
grant and the existing AssetHostTransport. BrowserEditor supplies its same recovered
Session storage port. Preview does not stage assets; Confirm import delegates to
PreparedImport.commitAssets, which stages the exact selected package and approved
embedded originals and uses the existing atomic content/adoption transaction.
Text-only imports remain ordinary prepared fragments and never adopt an asset.
The caller's selected File remains reachable through Download original file after
conversion/authorization failure or cancellation; its name/type/bytes are preserved.
Recovery downloads request browser delivery and do not prove OS storage success.

MFA-1.2 cases use the pinned canonical2 optional package with independently authored
ODT/PNG fixtures and deterministic granted, denied, wrong-hash and delayed-ingest
transports. They assert preview nonmutation, one history/update, undo/redo/reopen,
exact package/media retention, stable captured editor targets, background/pagehide/
read-only/stale rejection, and cancellation fencing. Host callbacks must honor the
AbortSignal and remain bounded/local. This portable proof does not qualify physical
devices, OS delivery, performance or release gates.


Integrated format qualification (MFA-1.4 / original MEX-1.6):

`npm run test:mobile-extensions -- --group formats` runs the packed production
presenter/Session/storage and authenticated optional worker, plus catalog checks.
The evidence-only [predicate registration](format-predicates.json) maps every
portable MWX-C21–C24 requirement to exact executed browser case names. The dispatcher
refuses missing, failed, duplicated or errored case evidence and emits
`format-reconciliation.json`, binding the registration, original catalog hashes
and browser receipt hash. Prepared validator negatives do not count as browser
observations; the catalog index retains pending platform observations.

| Original case | Reader-facing portable outcome | Evidence boundary |
| --- | --- | --- |
| MWX-C21 | File-input preview remains nonmutating; explicit confirmation uses captured anchors and one history/adoption group. Rejected originals, stale targets, cancellation and bounds preserve document/source recovery. | Actual installed Session, IndexedDB, undo/redo/reopen and two-editor isolation; prepared picker and approved-original transport. |
| MWX-C22 | Text/Markdown and qualified binary output preserve requested metadata and exact bytes. Prepare is distinct from save/share; failed save retains output and explicit Download file. | Actual worker and browser download request/byte stream; prepared save/write/close responses cannot prove OS storage. |
| MWX-C23 | Sharing requires explicit activation. Absent, unsupported, denied and canceled share retain output and offer download or suitable text recovery; dismissal never claims delivery. | Prepared share payload/status; no actual native share destination observed. |
| MWX-C24 | Clipboard refusal leaves selectable text; binary bytes retain download recovery. Exact direction/profile/fidelity menus exclude PDF import. Bounds, cancellation, revision and lifecycle fences prevent stale publication. | Actual production controls and worker termination; prepared clipboard/activation/mobile geometry. Native handles and OS delivery remain unobserved. |

Opening controls starts no conversion or permission request. Lower host bounds,
captured revision checks and actual blocked-worker bootstrap cancellation retain
prior output. Recovery downloads request browser delivery and never claim OS
storage success. Every receipt retains package byte sizes/hashes, exact fixture,
source and served-body hashes, browser engine and per-case resource counters.
These are raw provenance/cost observations, not timing or budget qualification.
Actual phone/tablet/OS file, share and clipboard outcomes, native selection handles,
IME/dictation/voice control/screen-reader observations, performance and release
predicates remain pending under the original platform owners (MWX-1.8/roadmap43).
