# Local reference document-store host

CLD-1.1 bootstraps the local host database and adapter harness. Run from `core`:

```sh
cargo +1.97.1 run -p editac-document-store --locked -- --store /absolute/local/host.sqlite
cargo +1.97.1 test -p editac-document-store --test bootstrap --locked
```

The command initializes or validates the database, prints its capabilities and
exits. The parent directory must already exist. It opens no listener, contacts no
issuer/provider and loads no credentials. Domain APIs are delivered by subsequent
CLD parents. This package is private and inherits Apache-2.0.

## Backend decision and limits

Use the existing locked `rusqlite 0.40.2` (MIT), `libsqlite3-sys 0.38.2`
(MIT license for bindings) and its bundled SQLite 3.53.2 (public domain). Reuse
the workspace pins instead of adding a second database driver. These versions
are published in the maintained [rusqlite project](https://github.com/rusqlite/rusqlite)
and [0.40.2 documentation](https://docs.rs/rusqlite/0.40.2/rusqlite/).
The runtime reports `rusqlite::version()`; the receipt pins the selected registry
manifests and embedded SQLite source. No claim that these are the newest releases
is necessary. SQLite's [license](https://www.sqlite.org/copyright.html) and
[transaction documentation](https://www.sqlite.org/lang_transaction.html) apply.

One file on an operator-owned local filesystem is the authoritative transactional
backend. SQLite can retain opaque immutable blob bytes in this same database;
the BlobStore stage/finalize/immutability adapter is still pending CLD-1.5/1.6.
No separate object store, distributed mutex or semantic replica is created here.

Connections require rollback-journal DELETE mode, `synchronous=FULL` and foreign
keys. SQLite serializes independent connections with `BEGIN IMMEDIATE`; lock
wait is capped at 250 ms and returns Busy, requiring bounded caller backoff.
Callbacks must perform bounded local SQL work with bound parameters, without
network IO or receipt emission. This is trusted adapter access, not a public SQL
endpoint. Large reads hold a write reservation too: concurrent read optimization
belongs to later measured work. SQLite's build-time length/page/variable limits
are not application quotas; explicit tenant, update, pagination and asset limits
remain pending their owning gates. Disk exhaustion can fail commit. There is no
automatic retry or host-replica support.

Process termination before commit rolls back; termination after confirmed commit
retains the bytes. This is a process-crash capability on tested local storage,
not host-loss, replica-loss, power-loss or disaster-recovery qualification.
SQLite [FULL synchronous semantics](https://www.sqlite.org/pragma.html#pragma_synchronous)
do not establish an untested storage device guarantee. A callback result is
returned only after commit confirmation. Commit errors conservatively return
CommitUnknown/Reconcile; a future operation ledger must resolve the outcome
before publication is retried. A successful bootstrap is not remoteCommitted.

## Schema ownership and migration

Migration 001 atomically creates only host metadata and stamps application ID
`0x45444143` and schema version 1. An empty unowned SQLite file can initialize;
a foreign nonempty file, unexpected owner, unsupported version/journal or damaged
metadata rejects. Startup does not repair, clear or downgrade an existing store.
Reopen does not reapply migration 001. Subsequent migrations need explicit version
transitions, transactional failure proof and forward recovery before enablement.
Keep backups and restore targets isolated; never test restore over active data.

## Contract map and pending compatibility decisions

The authority is `architecture/specs/cloud-document-store.md`. Frozen port names:
IdentityVerifier, AuthorizationPolicy, CatalogStore, UpdateStore, BlobStore,
CommitCoordinator, Relay. Names reserve boundaries; they do not advertise active
implementations. Backend errors freeze InvalidPath, Incompatible, Integrity,
Busy, Quota, Permission, Unavailable, Rejected and CommitUnknown, with explicit
Rejected/Unknown commit state and Never/Backoff/Reconcile retryability. Errors
omit SQL, paths and user content.

SYN: reuse the existing four separately versioned schema/update/sync/awareness
profiles and exact application receipt identity. A socket send/state vector is
not a receipt; presence stays ephemeral. Bootstrap's opaque fixture bytes do not
claim semantic validity, protocol compatibility or durable relay delivery.

CAP: reuse `DocumentIdentity`, `JournalEntry`, `UpdateId`, `PortError` and
`DurableReceipt` from the existing engine/session contracts. Document validation
uses the public shared JournalEntry constructor, with unsupported profiles rejected.
This server database is not a replacement client LocalStore/Session owner.
Content revision, catalog revision and object digest remain distinct.

RCH: reuse `AssetIdentity`, `AssetRequest`, `AssetGrant`, `AssetCommitReceipt` and
the existing `AssetHost` vocabulary. Prepared grant tests exercise the real RCH
validator; metadata does not grant access. Asset receipts remain separate from
document receipts. No upload/download availability is advertised yet.

Resolve before expanding each boundary: credential algorithms/key rotation and
server policy (CLD-1.2); tenant-scoped identity/epoch/catalog revision (1.3);
operation ledger/unknown commit recovery (1.4); adapting actual AssetHost requests
to staging/finalization, immutable blobs and quotas (1.5/1.6); durable publication
and SYN replay admission (later parents). No wire/ABI/spec change is introduced.
Deadlines/cancellation, retention, signed config, restore and provider qualification
remain later original gates; bootstrap cannot substitute for them.
