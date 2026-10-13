# Local reference durable relay

This is test-only integration infrastructure for SYN-1.5. It binds `127.0.0.1` by default and rejects non-loopback hosts. Prepared bearer tokens grant access to a complete immutable document identity. They demonstrate test authorization boundaries; they provide no production authentication, rate-limit, retention, TLS or deployment qualification. The service stores opaque bounded update bytes and validates envelope/content identity; it does not claim editor-schema admission.

Start explicitly with the pinned Node runtime and a persistent database path:

```sh
node examples/sync-server/serve.mjs /tmp/editac-relay.sqlite tests/fixtures/relay-grants.json
```

The launcher prints its PID and loopback URL. Stop it with SIGTERM or SIGINT. No service starts from package installation or import. Use a fresh database for isolated tests; the configured grants cannot reinterpret previously stored document/epoch metadata.

All requests are POST JSON with `Authorization: Bearer <prepared token>`. Requests outside these routes fail. The app envelope is independent of y-protocols baseline sync messages; ordinary sync never implies durable acknowledgment.

1. `/session`: `{identity, receiptProtocol: "editac-durable-receipt-v1" | null}`. The identity must match the prepared grant exactly. The response contains `session`, `identity`, `receiptProtocol` and `testOnly: true`. Absence/null means no receipt capability; unknown protocols fail. Send `x-editac-session` on subsequent requests. Sessions expire after one hour and are bounded to 64.
2. `/updates`: `{identity, writerId, sequence, origin, bytes, checksum, updateId}`. `bytes` is canonical base64, checksum is lowercase SHA-256, and updateId follows the existing journal identity: JSON `[identityKey, writerId, sequence, checksum]`, where identityKey is JSON of profile/schema/documentId/epoch/protocolVersion/updateEncoding/offsets in that order. Writer/sequence use the current journal's positive integer constraints. Response contains `cursor`, `duplicate`, `receipt`, `remoteDurability`. The receipt matches the existing UpdateOutbox shape. Without negotiated capability, receipt is null and remoteDurability is unknown even though storage committed.
3. `/replay`: `{after: 0, limit: 64}`. Returns `{entries, after, done}` with stored update envelopes and server append cursors. Use the returned cursor until done; do not order replay by writer sequence. Empty replay means only no stored updates, never permission to initialize a document.

SQLite WAL with `synchronous=FULL` stores complete identity/content atomically under the unique document/epoch/writer/sequence key. The service emits receipts only after COMMIT returns. Exact duplicate bytes reuse the stored cursor and receipt; reused writer/sequence with different content fails with 409. Failed transactions roll back. A crash after commit but before reply is recovered by replay or duplicate retry. This qualifies tested local process crashes, not hardware/power loss or production service durability. SQLite calls use Node's [built-in synchronous API](https://nodejs.org/api/sqlite.html).

Default bounds: 1 MiB raw updates, 1 MiB raw replay pages, 64 records per requested page (maximum 256), 32 serialized storage operations, 64 connections and 10-second HTTP request/header timeouts. JSON framing overhead is bounded separately. Queue saturation returns 429 without a receipt; clients retain and retry pending bytes. In-process `revoke(token)` removes grants/sessions. Host-level backoff and client recovery are separate gates.

`fault(boundary, entry)` is harness-only injection at before-transaction, before-commit, after-commit and before-receipt. It is never exposed over HTTP. The named check uses real loopback transport and child process termination, actual Rust/Yjs updates for semantic replay, and explicitly opaque byte fixtures for admission limits:

```sh
node --test tests/server-receipts.test.mjs
```

Tests stop every child, verify listener removal and remove temporary databases. Optional `EDITAC_RELAY_OUTPUT` retains logs, process ownership, fixture hashes and harness results as qualification evidence.
