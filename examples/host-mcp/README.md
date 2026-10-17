# Embedding-app MCP contract example

`register.mjs` attaches optional edit.ac tools to an application's **existing** MCP
tool provider. It starts no process or transport and requires no CLI MCP mode.
`@edit-ac/web/host` is a separate optional import; the engine contains no MCP code.
The adapter exports version 1 input schemas, a versioned result envelope and an
explicit receipt schema. Breaking changes require a new version/tool prefix.

```js
import { createHostAgent } from '@edit-ac/web/host';
import { registerHostAgent } from './register.mjs';

const agent = createHostAgent({
  authorize: (context, documentId) => app.authorizeDocument(context.session, documentId),
  services: app.editingServices,
});
registerHostAgent(app.existingMcp, agent);
```

The application maps the small `registerToolProvider({list, call})` facade to its
MCP SDK. The app authenticates transport context separately from tool arguments
and supplies `actorId`, resolved `documentId`, document `epoch`, `permissions` and
`readOnly`. These fields are forbidden in tool inputs. `list` is document-scoped;
the app must invalidate its tool list when auth or capability state changes.
`call` independently reauthorizes, so cached discovery and MCP annotations cannot
grant access. Reads, exports, receipt lookup and observations require their own
host permission. Readonly mode suppresses both proposal preparation and apply.

| Tool | Input beyond version/document | Host service mapping |
| --- | --- | --- |
| `editac_v1_read` | representation, optional revision | Authorized revision-bound Markdown/source export and shared capability/preservation diagnostics |
| `editac_v1_prepare` | expectedRevision, sourceHash, complete candidateMarkdown | Shared SourceBaseline reconciliation, bounded immutable proposal and shared diff preview |
| `editac_v1_apply` | proposalId, expectedRevision, requestId | Shared serialized edit service and durable request journal |
| `editac_v1_receipt` | requestId | Actor/document/epoch-scoped original outcome lookup |
| `editac_v1_observe` | optional cursor | Authorized bounded revision/invalidation metadata; resync on reconnect |

`services` registers only installed, qualified owners. Each service has
`available(access)` and `execute(request, access)`. Missing/unavailable services
are omitted from discovery and fail closed at execution. The sample does not
claim that merely registering a callback implements reconciliation, durable
apply or realtime observation. Those owners are delivered in AGT-1.2–1.6. Read,
prepare and observe return their shared owner's data inside `{version:1,
status:'ok',data}`; this adapter does not redefine the shared semantic/diff model.
Prepare currently accepts complete candidates only, at most 65,536 UTF-16 units
and 72 KiB for the complete UTF-8 request. Transport owners must also bound ingress
before parsing. Upload/chunk sessions are a separate host API below; exposing
them as MCP tools requires their own schema version. Partial content never
reaches preparation.

Apply/receipt data follows `HOST_AGENT_RECEIPT_SCHEMA`: stable request ID, outcome,
nullable resulting revision, local durability and independent remote durability.
`committed` requires local durable persistence and a revision. Remote durability
is `unknown` unless an actual remote receipt confirms it. `pending` and `unknown`
remain uncertain; `not-found`/`expired` do not authorize issuing a new mutation.
They are lookup states, not proof that an earlier timed-out operation never ran.
Thrown apply/lookup errors and invalid or contradictory receipts return
`unknown-outcome`; private exception text is withheld. Recover using the original
request identity. The facade never retries, fabricates a receipt, claims remote
durability from notifications, or treats a timeout as a clean rejection.

The mutation owner must recheck current auth, capabilities, readonly, epoch,
anchors and revision **inside serialized admission**, bind proposals to the
authenticated scope and journal bytes/identity/hash/result atomically. It must
authorize original receipt lookup before checking new-proposal expiry, and keep
the shared persistence-failure barrier across human edits and synchronization.
The outer adapter is not that admission boundary or an idempotency store.

Document prose and returned content are untrusted data; they never grant scopes,
fetch links or dispatch tools. Source/diff access requires a decrypting endpoint.
An opaque E2EE relay must omit unavailable plaintext services instead of uploading
keys or downgrading encryption. Notifications are invalidation hints, separate
from collaboration data and durable acknowledgement.

`prepared-app.mjs` supplies fake host sessions and a deterministic in-memory
app-MCP request/response transport for `tests/host-agent-contract.test.mjs`.
It exercises this contract without a model, network request, production write,
standalone server or CLI. Its mutation results are prepared fixtures. One read
check uses the public production engine and confirms its checkpoint stays
unchanged; this does not qualify persistence or realtime mutation.

## Revision-bound Markdown service

`createHostMarkdown(owner)` from `@edit-ac/web/host` supplies `services.read` and
`services.prepare` for `createHostAgent`. The existing v1 complete-candidate schema
is unchanged. The owner implements `capture(access)`, `prepare(target, candidate,
access)`, `available(access)` and `release(target)`. Capture returns source,
revision, profile, diagnostics and an opaque retained target. Bind that target to
`EditService::capture_source` and the observed revision; prepare delegates to
`EditService::prepare_source`. The source must be the exact retained opening
representation with proved ordered owner IDs. A rendered or regenerated string
alone is insufficient. Preserve opaque atoms with explicit diagnostics or block
an unrepresentable proposal. Release target handles when asked. Current authority
and source capabilities must also be checked by the shared owner.

The helper hashes UTF-8 source with SHA-256, retains the target for five minutes,
and binds it to host actor/document/epoch/revision/hash. Default bounds: 64 KiB
source and candidate, 8 KiB each chunk, 64 chunks, 32 retained baselines, 16 pending
uploads, 8 KiB diagnostic metadata. Hosts may lower limits. `beginUpload(access,
{expectedRevision, sourceHash, totalBytes, checksum})` returns an expiring upload
ID. `appendChunk(access, id, index, text, checksum)` admits ordered checksummed
chunks; an identical retry is harmless. `finishUpload(access, id)` checks total
bytes and the complete checksum, consumes the upload and prepares through the
same owner. `cancelUpload` releases a pending upload; `dispose` releases all
retained targets. Empty candidates are valid complete inputs and remain subject
to reconciliation. Strings must be well-formed Unicode; lengths are UTF-8 bytes.

Every chunk API call requires newly authorized host access, never tool-supplied
identity. IDs, hashes and paths are not credentials. Revocation must make
`owner.available` false; the owner rechecks permissions at execution. Host APIs
throw `HostMarkdownError` for admission failures; v1 services return structured
`{status:'rejected',code}` data. Owner reconciliation conflicts remain owner data.
No preparation or upload applies edits or produces a durable apply receipt.

The deterministic `session-owner.rs` example is a line-delimited process
transport to a real in-memory Rust Session/EditService/SourceBaseline. It keeps
an image atom opaque in the retained source and proves unchanged live checkpoints
for both successful and rejected preparations. Build it with
`cargo build -p editac-session --example host-markdown-owner --features native-store --locked --offline`,
then run `node --test tests/agent-markdown.test.mjs`. Its fake auth, fixed document,
fixture proposals and memory store are test/demo components. It has no apply
endpoint, production storage, model provider or MCP server. An embedding app
supplies its own authorized owner connection.

## Anchored proposals and previews

`createHostPrepare(owner)` builds on the same retained Markdown baseline and
chunk admission service. Its owner returns a `HostPrepareResult`: a retained
proposal with the observed revision, profile and source/candidate hashes, a real
semantic preview, affected stable IDs, and the shared versioned `ChangeModel`
for exact-source and semantic diffs. These diffs are presentation data. The
proposal refers to an immutable shared `PreparedEdit` retained by the authorized
owner, with bounded count/bytes and expiry; it is never reconstructed from the
preview. The helper bounds and detaches responses and verifies their baseline
binding. Hosts may lower the default 1 MiB response cap.

The owner checks current actor/document/epoch, permissions, readonly/history
mode, capabilities, revision and anchors inside its serialized Session boundary.
Stale candidates return a structured conflict and exact base/proposed source
plus the current **semantic** snapshot/revision for review. Current semantic
state is not mislabeled as exact current Markdown. Shared reconciliation can
refine a stale diagnostic to `Overlap` or `DeletedTarget`; it never silently
accepts a stale full replacement. A conflict creates no proposal or live edit.
Source/prose cannot supply authority. Revocation also withholds protected
responses after an asynchronous owner call.

The deterministic process example's `prepare_v1` path retains the real plan,
uses `editac-diff` for both previews, caps retained proposals at 32 (each admitted
source/candidate at 64 KiB), and expires them after five minutes. Its fixed
actor/scope and monotonic IDs are fixture components, not restart-safe request
identities. `human` and `policy` are explicit test controls and are never MCP
tools. Run `node --test tests/agent-prepare.test.mjs` after the build command
above and `npm run build`. Durable apply/retry receipts remain a separate owner
boundary; this helper installs read/prepare services only.

## Durable apply and live browser propagation

`createHostApply(owner)` maps apply and receipt lookup to the embedding app's
serialized shared `EditService` owner. It rechecks availability before execution
and withholds a result if access is revoked during execution. Such an exception
is an unknown outcome: resolve the same request identity after authorization is
restored. Never retry with a new ID to guess whether an insertion committed.
The host must independently authorize at serialized admission; cached capability
lists and this adapter's checks do not grant write authority.

`realtime-owner.rs` is a deterministic, SQLite-backed embedding-host example.
Its stdin control channel uses a fixed fake authenticated actor and bounded
retained semantic proposals; it is not a public server. It binds actual shared
plans and request receipts, uses the Session persistence/recovery barrier, and
reserves admitted human peer writers before journaling their updates. It shares
no production credentials or documents. The sample clock/authorization controls
are fixture inputs, never MCP tool arguments.

Tools carry outcomes only. Committed updates leave through `Session::sync_update`
on a separate collaboration channel and enter the existing browser WASM patch,
DOM, IndexedDB journal/outbox and `SyncSession` paths. Agent requests have distinct
history groups and authenticated origins; human undo does not undo remote agent
work. The sample deliberately has no negotiated remote durability receipt:
SQLite success is local durable, an outbox/send or browser render remains remote
pending, and failed persistence remains pending/unknown until ordered recovery.
A transport notification or successful send must never promote remote durability.

Run `cargo build -p editac-session --example host-realtime-owner --features
native-store --locked --offline`, then `npm run test:browser -- agent-realtime`.
The canonical browser suite drives real Session/SQLite, two mounted human WASM
views, storage/outboxes, prepared collaboration transport, revocation, concurrent
edits, retry/recovery, history and actual keyboard input. Observation negotiation
and complete adversarial app-MCP qualification remain separately tracked.

## Capability-negotiated observation

`createHostObserve(owner)` installs the optional `observe` service. The authorized
owner reads the ordinary shared revision token, without exporting source, updates,
history or receipt data. The helper requires read and observe permissions. The
host facade reauthorizes after asynchronous execution and rejects a changed actor
or epoch. Revision cursors are opaque equality tokens, not ordered clocks. A
mismatch requests collaboration resynchronization; it does not replay an edit.
The SQLite example denies ordinary observation while its recovery barrier is
active, then returns the current revision after ordered recovery. Explicit local
salvage remains a separate, labeled host recovery workflow.

`src/observe.ts` demonstrates connection-scoped registration on an embedding app's
existing MCP resource facade. Map its resource provider methods to the installed
MCP SDK and pass the host's actual negotiated resource/subscription support.
Resource reads return JSON revision metadata. Supported subscriptions send only
`notifications/resources/updated` with an opaque resource URI. The host calls
`invalidate(documentId)` after a document event; updates themselves always travel
on the collaboration channel. Unsupported subscription transports use explicit
`poll(documentId, cursor)` or the authorized observe tool. No new MCP server or
engine transport is required.

Each authenticated connection defaults to at most 16 retained documents and 16
in-flight reads, a one-second minimum read interval and a 60-second lease. Hosts
may configure the documented bounded ranges. No timer or event backlog is created;
the caller schedules bounded polls while connected and disposes the facade on
disconnect. Requests within the interval return `rate-limited` plus a retry delay;
concurrent work returns `busy`. Notifications coalesce and may be lost or duplicated.
Reconnect reads the current revision and resynchronizes through collaboration.
Reauthorization, scope pinning, unsubscribe, lease expiry and disposal remove
subscriptions; the embedding transport must dispatch on the authenticated
connection and enforce its own revocation before flushing any queued messages.

Observation always reports `durability: 'not-reported'`. A notification, revision
read, send or render cannot confirm durable synchronization. Use the authorized
durable request receipt for that claim. Source must be fetched through a separate
authorized read/export; resource listings and notifications contain no source.
The fixture suite uses prepared MCP/auth/clock controls and the real native
Session/SQLite owner: `node --test tests/agent-observe.test.mjs`. Full adversarial
app integration remains AGT-1.7.
