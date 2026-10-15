# STB-1.5 shared atomic-content delivery

Implemented and verified at the shared port; not main-integrated, deployed or a
native SDK acceptance claim. Original DSK-1.11 native P2b/full, DSK-1.10 and
DSK-1.15 acceptance remain open. STB-1.6 final qualification/request and MONITOR
ONLY STB-1.7 remain open. No provider, network, provisioning or publication calls.

Core implementation `5cbdded87f31571db47bc6a800e8a197fefde1ec`, formatted-proof
completion `87898b4f3b799399a3384d77209c2684a772d7c9`; architecture contracts
`d31201f63014199c136efbb5c2415b2b4d2319e8`. The immutable roadmap source revision
is `d13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526`, prompt
`2e18a98412c7`. No native/macos consumer source was edited. Its existing attachment
and table corpus factories are consumed unchanged as prepared baseline data.

## Implementation

`setAtomicContentPolicy(images, references)` changes only existing HostPolicy
flags through EditService on the serialized owner. Every create/open defaults off.
The single portable `atomicContent` DTO translates to the shared Rust command;
there is no native semantic dispatcher or additional model. Complete expected
tuples, source-owned anchor at offset zero, current ObservedRevision, same-family
known v1 replacement and existing content/resource admission are required. Null
replacement removes the entire atom and fallback, leaving an empty paragraph at
its retained owner and position. Typed Content validation and the established
prepared staging/text planner produce one live Session/history/SQLite commit.
Neither host policy nor catalog availability grants permission or a resolver.

Asset/reference values are deterministic inert descriptors, not uploaded/fetched
resources. Trusted hosts own resolver/asset decisions and retain the captured
Session target; cancellation consumes the prepared token. Foreign, released,
partial, stale, expired or disposed targets cannot redirect a delayed result.
Catalog profile reasons explicitly scope availability to inert replacement/removal
with host resolution and target checks required. No full presenter, resolver,
production encryption or native UI/IME capability is claimed.

## Original STB-1.5 criterion matrix

| Original criterion | Actual evidence |
| --- | --- |
| Explicit image/reference policy, default denial and no permission grant | Rust default/transition and both-family/all-action tests; generated policy/readonly/expiry cases; default-off durable reopen |
| One shared portable route, no direct native tuple/SQL mutation | `EditorCommand::AtomicContent`, `interchange::Command`, EditService requirements; actual production WASM tests and generated NativeSession commits |
| Complete descriptor/owner/revision/captured anchor, version and bounds | Rust descriptor/anchor/version/resource cases, foreign/released/nonzero anchors; generated foreign/released/cancelled host-result and remote stale cases |
| Safe inert source, image URL, label/ID and resolver/asset ownership | Existing Content validation; javascript URL/control-ID/overlong label/alt/future-version rejection; source-owned anchor plus host-owned deterministic descriptors, no network or foreign resource handles |
| Successful image AND reference replacement AND whole-atom removal | Rust success loop and generated success cases 1/2, real SQLite durable receipts; WASM success for both families |
| Undo/redo/reopen and surrounding content/format retention | Rust baseline has bold/italic surrounding owners; generated setup applies actual bold/italic commands before replacement/removal; exact surrounding snapshots, history and reopen comparisons |
| Readonly/expiry, stale/cancelled/resolved-late/foreign targets | Rust both-family/all-action admission matrix; generated policy/cancel/expiry/late-disposal, explicit host-result and distinct-store remote cases |
| Invalid payload/limits and disposal | Rust rejection cases are byte/revision/visible-state silent; generated invalid URL and disposed completion; canonical current lifecycle/anchor/command suites |
| Accepted-update retention, freeze and correct idempotent recovery | Rust eight combinations: image/reference × replacement/removal × before-commit/lost-ack append fault; retained update/export, absent revision/frozen mutation, exact recovery and preserved undo |
| Reuse STB-1.3 remote boundary | Actual distinct SQLite peers, existing writer reservation/pending update/receive adapter, convergence/stale prepared commit rejection and local history preserving remote reference |
| Additive generated bindings, old layouts/error order/consumers, truthful contracts | Current Swift/header/Kotlin, 96 exact ABI checks against e4d82b7, unchanged prior Session and legacy engine consumers, native ABI tests and four additive authoritative specs |

## Final checks (497 executed, zero failed/skipped)

- Native Rust **128**: 69 library + 8 ABI + 9 Session + 4 profiles + 25 commands
  + 13 projection. `rust-final-lib.log` retains full 69; the final formatted
  baseline materially changes only seven atomic cases, refreshed **7/7** in
  `rust-formatted-atomic.log` (62 unrelated tests filtered, not skipped/passed).
  Unchanged integration proof is `rust-repaired.log`; the seven refreshes replace,
  rather than add to, the 69 library count. Both executed binaries are retained.
- Core **36**: 22 library (`core-tests.log`, passing before setup failure), then
  4 extension commands + 3 inert content + 2 references + 5 table structure in
  `core-repaired.log`. Session table commands **3** (`session-tests.log`).
- Current generated Swift **125**: 58 semantic + 59 instrumented + 8 unchanged
  legacy engine, `swift/receipt.json`, final attempt-5. Buffers **1,574 lifts/frees**,
  105 foreign frees. Prior unchanged Session **12**, `backward/receipt.json`.
  Combined Swift executions: **137**. Actual macOS arm64 runtime; no AppKit claim.
- Authoritative bindings/typecheck **77**, `bindings/bindings-receipt.json`;
  exact public layouts/method checksums/prior header ABI **96**, `abi-audit.json`.
- Production WASM **6**: four table cases in `wasm-commands.log` remain passing;
  both atomic cases in `wasm-atomic-repaired.log` pass. Current production WASM
  and package were built from this checkout (`wasm-build.log`, `wasm-runtime/`).
- Architecture **14**, `architecture-final.log`; owned Rust formatting, source
  and contract whitespace pass. Full implementation diff whitespace also passes.

Passing evidence is reused only for unchanged inputs. No skips count as passes.
The final public packed size/loading/compatibility/AppKit applicability matrix is
STB-1.6 work; this receipt does not close it or imply a hard-cap/release claim.

## Retained initial failures and repairs

- `rust.log`: 61 passed/6 failed, zero ignored/filtered. Five new image cases hit
  the new planner's wrong fallback accessor; repaired to use typed Image.source.
  The sixth used ambient Node 24.21.0 instead of pinned 24.19.0; PATH was repaired.
  Requested integration suites were not reached in this failed phase.
- First Swift setup (`swift-driver.log`, attempt-1) used an incorrect archived
  helper path; no semantic cases executed. Correct retained helper path supplied.
- `wasm-commands.log`: 5 passed/1 failed, zero skipped. Reference baseline omitted
  its required label text; fixture repaired to supply matching text. Both atomic
  cases then passed; unchanged passing table cases were not repeated.
- `core-tests.log`: library 22 passed, extension commands 0 passed/4 failed because
  EDITAC_EXTENSION_COMMANDS_OUTPUT was missing. Three later suites were not reached.
  A unique worktree-owned output path was configured before the repaired 14 checks.
- Formatted Swift attempt-4: 56 passed/2 failed, zero skipped; new surrounding-mark
  setup used `add` instead of the existing `apply` action. Repaired setup, then
  final attempt-5 passes all semantic/instrumented/legacy executions. Attempt-2/3
  successful pre-format proofs are retained but not added to final counts.
- `format-initial.log` retains initial formatting diagnostics, repaired before
  feature proof. All failed logs/stores and successful artifacts are preserved.

## Reproduction and exact inputs

Use Rust 1.97.1, Node 24.19.0, locked offline Cargo caches and the existing native
SQLite toolchain. `source-envelope.json` binds complete relevant sources,
fixtures/toolchain files and generated declarations, including the three
pre-existing unrelated dirty sources. `unrelated-baseline.json` proves those
sources match both session entry and the previous qualified source envelope;
they were never staged or committed here. Exact checkout evidence is not a claim
that a clean source commit includes those unrelated dirty files.

The current library, generated declarations, Rust/Swift executables, WASM runtime,
prepared authority helper, baseline corpora/stores and logs are retained locally
in this directory and bound by `artifact-envelope.json`/`delivery.json`.
The helper is byte-identical to the prior qualified prepared authority/MLS fixture;
no security source changed. Generated collaboration cases reuse it with current
actual NativeSession peers. It grants no production security qualification.

From core, set `OUT` to a new absolute evidence directory and prepend pinned Node
to PATH. Run the unchanged attachment factory with `CARGO_TARGET_DIR=$PWD/target`
and `EDITAC_NATIVE_SESSION_EVIDENCE=$OUT/attachment-fixture`. Run:

```sh
cargo +1.97.1 test -p editac-ffi --locked --offline --lib --test native_session --test native_session_commands --test native_session_command_profiles --test native_session_projection --test native_abi
CARGO_NET_OFFLINE=true python3 tests/native/bounded-bindings.py --output "$OUT/bindings"
# Copy the binding receipt to $OUT/swift/bindings-receipt.json first.
python3 tests/native/session-command-proof/run.py --output "$OUT/swift" --table-fixture tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json --attachment-fixture "$OUT/attachment-fixture/manifest.json" --host-transport --authority-fixture tests/native/table-session-proof/stb-1.5-20261015/native-host-admission
python3 tests/native/session-backward.py --output "$OUT/backward"
npm run build:wasm
node --test tests/atomic-content-commands.test.mjs tests/table-commands.test.mjs
```

For extension command regression set a unique EDITAC_EXTENSION_COMMANDS_OUTPUT.
Other exact suite invocations and outcomes are identified in the preceding check
list. Hygiene paths and reclaimed bytes are in `hygiene.json`; retained evidence
is preserved, and no task browser/server remains.
