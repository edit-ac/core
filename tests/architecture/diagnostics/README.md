# Redacted support diagnostics

Run `node scripts/check-architecture.mjs --suite diagnostics` with `.node-version`.
The canonical dispatcher rejects unknown/empty suites and incomplete/skipped counts.
Rust's `diagnostics` integration target also runs independently with
`cargo test -p editac-session --test diagnostics --locked --offline`.

`SupportDiagnostics` is an opt-in bounded collector, separate from the session's
content-bearing `recovery_export`. Version 1 support exports accept only closed
source/error/recovery/state vocabularies and bounded numbers. Operation IDs are
collector-local monotonic numbers, not document IDs, provider IDs or hashes of
private content. Keep a collector per host session. No message, title, scope,
URL, payload, token, key, checkpoint, journal or command origin is accepted.
The last 64 events are retained; `dropped` reports omitted events. Timings clamp
to one day, queue/pending counts to 4096 and identifiers/counters to the exact
JS integer range. Support collection never mutates document/recovery state.

The Rust collector consumes actual `SessionState` and typed errors; the web
wrapper consumes actual `ServiceLifecycle` outcomes and preserves the caller's
original derived result. Hosts can record production resolver `lastOutcome`.
Recovery labels are guidance, never automatic retry/authorization/mutation:
`recover-store` requires host capacity/fault repair and exact session recovery;
`commit-unknown` must reconcile persisted bytes before retry. Integrity/sequence
failures preserve content-bearing export for the authorized user; incompatible
schemas require an admitted migration/export workflow. Permission loss requires
fresh host authorization, stale derived work requires a new scoped request and
saturation waits for capacity. Disposal/cancellation never revive old work.

The shared `failures.tsv` pins portable/web spellings and routes. Canonical proof
uses actual Rust session/fault-injected memory store, production reference lookup
and web lifecycle with seeded private text/titles/credential URLs/tokens/keys.
Converter and host sources use prepared providers through the real lifecycle;
they qualify diagnostic privacy/routing only. They do not manufacture optional
provider support, crash durability, native/platform qualification or live usage.
Raw typed support artifacts, nested Rust counts, exact input/bundle hashes and
canonical TAP/receipt are retained in the configured output directory. Prepared
store durability is explicitly volatile. Failed receipts remain evidence.
