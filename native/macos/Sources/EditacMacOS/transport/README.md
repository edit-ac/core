# Local document lifecycle prerequisite (DSK-1.15-P1)

`NativeDocumentCoordinator` takes lifecycle ownership of an opened native editor.
Use `switchDocument` to open/restore a private candidate, then close the existing
Session through its durable FIFO barrier before publishing the replacement.
Opening failure or cancellation preserves the old editor; close failure preserves
its recovery export and retry path. A candidate created before cancellation or a
failed close remains a local durable store. The host owns its path and may reopen
it; the coordinator never deletes a document or rewrites its history.

`cancelSwitch` accepts cancellation only while opening. After closing starts,
accepted edits settle and the switch finishes. Concurrent transitions reject
with `closing`. The switch completion runs once, after release of the old owner
or rejected candidate. `close` uses the same durability/recovery barrier.

`revoke(now:)` invalidates delayed host/OS input, cancels provisional composition,
and replaces cached local permission through the existing serialized Session.
Earlier accepted work retains its real local receipt. Renew permission through
the existing trusted host command API; renewal cannot revive captured input from
before revocation. Clock values belong to the host's existing Session domain.

Capture `scope` when beginning delayed presentation work and call
`deliver(ifCurrent:)` immediately before applying its result. Scope is bound to
one coordinator and activation/policy generation. Callback results for another
host, switched document, revoked policy or disposed editor are ignored. Scope
is not a shared anchor, transport authorization lease or semantic mutation grant.
Do not dispose the transferred editor independently during an active transition.

The `collaboration-lifecycle` dispatcher suite uses actual Rust Session, SQLite,
generated Swift and AppKit. It does not implement transport, presence, remote
selection, reconnect or convergence. Original DSK-1.15/I1/V1 remain unchecked
until PRIMARY's qualified shared ports are consumed and canonical collaboration
passes. No platform, IME, VoiceOver, package or release support is qualified here.
