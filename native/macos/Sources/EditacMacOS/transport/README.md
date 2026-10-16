# Native collaboration and document lifecycle

`NativeEditorView.collaboration` binds the existing shared Session Host* ports to
an event-driven, host-injected `NativeCollaborationTransport`. Supply a complete
scoped identity, exclusive host-clock authorization expiry, queue bounds and the
negotiated durable-receipt capability when connecting. The host authenticates its
transport and verifies/decrypts its own envelope before admitting sync updates,
awareness or application receipts. IDs/checksums are not authentication. The SDK
installs no networking, timers, key discovery or production identity service.

Capture the returned `scope` for every delayed event. Reconnect creates a fresh
scope and shared worker token. Use `disconnect(in:scope)` for delayed transport disconnect events; the unscoped form is an immediate local lifecycle action. Old scopes cannot drain, publish, ingest, acknowledge
or affect a replacement. `disconnect` invalidates presentation immediately and
queues a FIFO detach barrier even when the previous attach is still queued. The
executor owns all Rust handles, SQLite calls and callback ordering; disposal
suppresses callbacks and releases the owning worker.

`flush` sends one bounded page from the actual persistent outbox through the
injected transport. The host can advance with the exact last sent journal identity
as `after`; use a page size within the negotiated queue limits. The corresponding
update records identify the shared y-protocols frames; they do not define another
wire protocol. A send failure or reconnect retains pending work for replay. Send,
frame drain, awareness and ciphertext receipts do not acknowledge durability.
Only an authenticated, exact, negotiated application receipt goes to `accept`.
Incoming updates require the host's existing writer reservation and admission;
`receive` returns after actual durable Session ingress and native projection.

`publishSelection` captures shared portable anchors from committed native UTF-16
selection. Provisional/pending composition cannot publish. `receivePresence` and
host-driven `refresh(now:)` render resolved remote ranges and a native participant
status label (mounted by the host alongside its local-save label) without moving local selection or touching history/receipts. The
shared awareness owner enforces coalescing, expiry and tombstones. Expired leases
and recovery failures clear remote presentation and surface unavailable state.
Production encrypted collaboration and actual OS/IME qualification remain with
their owning tracks.

`NativeDocumentCoordinator` takes lifecycle ownership of an opened editor.
`switchDocument` opens/restores a private candidate, invalidates old host/input
scope and disconnects before closing the existing Session through its durable
FIFO barrier. Only then is the replacement published. Opening failure or opening
cancellation preserves the old editor. Close failure retains recovery/export and
retry; the disconnected old editor can explicitly reconnect. Candidate stores
are host-owned and are never deleted by the coordinator.

`cancelSwitch` applies only while opening. After closing begins, already accepted
edits settle and the switch finishes. `revoke(now:)` disconnects the host transport,
invalidates delayed OS input, cancels provisional composition and replaces local
permission through the same serialized Session. Earlier accepted work retains its
real receipt. Renewal cannot revive old captured input. `close` uses the same
durability/recovery barrier. Capture coordinator `scope` for delayed presentation
work and use `deliver(ifCurrent:)` immediately before displaying it; semantic
mutations still require shared anchors/admission.

The `collaboration` suite uses two AppKit editors, separate real SQLite stores,
generated Swift, actual Rust Session transport/awareness/history and a deterministic
host/transport with exact prepared envelope admission. `collaboration-lifecycle`
retains the independent opening/cancellation/recovery/disposal prerequisite cases.
No paid services, live credentials, network service or publication are involved.
