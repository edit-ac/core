# Optional AI host transport v1

`editac-ai-text-v1` is an ephemeral service contract, not a persisted module
schema. Import the optional `@edit-ac/core/extensions` entry point. Registration
advertises Ask AI (`ask`), fill/continue (`fill`, `continue`), selected-text
transformation (`rewrite`) and opt-in `completion`. Registration does not enable
background completion. Absent, disabled or unconfigured services make no request.
Presenters must show an availability reason before asking for context.

The host supplies explicit per-editor request, instruction/context/output UTF-8
byte and elapsed-time limits, a current remote-transmission policy, a transport
and quota reservation. Maximum configurable bounds are 10,000 requests, 16,384
instruction bytes, 32,768 context bytes, 16,384 output bytes and 120,000 ms.
TypeScript uses the existing defensive descriptor-data copier; all admitted data
is copied and frozen before host dispatch. Quota reservations and failed attempts
are never automatically refunded. Regeneration is a new admitted request. A host
must retain its quota ledger across editor reconfiguration where appropriate;
creating a new editor must not reset an account-wide cap.

Requests expose selection, bounded passage or explicitly selected document scope.
The caller supplies only the authorized immutable text for that scope; this
contract performs no retrieval. Protected documents and absent transmission
permission reject. Credentials, provider/model choice, account quotas and monetary
admission belong exclusively to the host/backend. There are no ambient keys,
SDK imports, secrets, automatic fallback, tool execution or retries here.

Local captures use existing `StableRange` anchor tokens and document identity plus
revision. They are never sent in the transport envelope. The owning proposal
session must release anchors and recheck target/context/permission on acceptance.
This boundary has no document, selection, history, storage or commit capability.
RCH-2.2 owns proposal assembly and semantic acceptance. V1 only accepts
`plain-text`; rich/HTML/tool output rejects instead of silently flattening it.

Responses carry version, request ID and zero-based contiguous sequence. A delta
contains nonempty text; exactly one finish/error terminates a stream. Finish usage
has nullable input/output token counts. Unknown usage stays null; no price or
inferred cost is attached. Error codes are portable categories, never raw backend
messages. TypeScript checks envelopes, cumulative output bounds, cancellation and
elapsed timeout and closes its iterator on teardown. A host must honor the abort
signal at its own backend; local cancellation alone cannot prove provider abort
or reverse billing. Rust supplies a host-implemented transport with shared
cancellation and explicit limits, without prescribing an executor. It validates response identity/order, cumulative output and terminal state, and
checks elapsed time at callbacks/return. Its host must interrupt blocked I/O at
the deadline; a synchronous callback cannot preempt an uncooperative host. Neither contract is a second engine.

## Default Vercel AI SDK Core backend mapping

This is the adapter mapping, not installation or runtime qualification of an SDK
release. No SDK/provider package or model is selected by v1. Before shipping a
backend, its host must pin a stable compatible SDK/provider combination and qualify
it with prepared models and simulated streams, including abort and retry counts.

| Portable boundary | Backend mapping |
| --- | --- |
| `ask`, `fill`, `continue`, `rewrite` | `streamText` with an explicit host-selected model; instruction and scoped context passed as untrusted content, no tools/agent loop/retrieval |
| `completion` | short bounded `generateText`; emit its complete text as delta sequence 0, finish sequence 1; no streamed ghost-text default |
| Streaming | SDK text deltas become successive portable deltas; nontext/tool payloads reject; do not forward raw SDK objects |
| Request limits | reserve host quota before calling SDK; host converts output allowance into its model token bound and enforces UTF-8 bytes/time independently |
| Cancellation | propagate client AbortSignal to host HTTP/runtime and SDK `abortSignal`; reject late output; backend must confirm resource release |
| Retries | explicitly `maxRetries: 0`; disable provider/stream retries too; no fallback or implicit gateway model |
| Finish | awaited available token usage maps to nullable portable counters; emit exactly one finish; unknown monetary usage remains unknown |
| Failure/abort | map to `transport`, `timeout`, `canceled`, `quota` or `invalid-response`; no raw error/credential/context leakage |

The backend can run outside Vercel hosting and native clients can consume this
same protocol without JavaScript. Prepared fixtures prove contract plumbing only;
they establish no model quality, live cost, provider support or launch qualification.
