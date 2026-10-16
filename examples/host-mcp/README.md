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
before parsing. Upload/chunk sessions and semantic proposal forms require their
own later schema revision; partial content must never reach apply.

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
