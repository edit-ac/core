# Browser recovery boundaries

Run `npm run build`, then `npm run test:browser -- recovery`. The existing pinned
Playwright dependency selects its installed headless Chromium executable. Each
case uses a disposable persistent profile and an ephemeral loopback fixture
server. `EDITAC_RECOVERY_OUTPUT` selects a durable evidence directory.

Six cases cross two termination mechanisms (CDP renderer crash and OS browser
PID SIGKILL) with three storage boundaries:

- Three completed journal updates, restored from the initial checkpoint.
- Completed checkpoint publication followed by a completed journal tail.
- Native request success while its transaction is held active, after three
  acknowledged updates. The held update is lost on termination: this pre-ack
  loss is outside the localCommitted guarantee.

The fixture uses actual Rust/WASM editing, leased writer identities and production
IndexedDB adapters. It compares independently expected Unicode text and every
acknowledged identity/byte, then commits an edit after recovery. Unload and
pagehide registrations are rejected before module initialization; no graceful
flush, destroy or page close precedes a crash. Facts include actual transaction
durability, browser version, process termination and cleanup.

This proves the tested desktop Chromium process boundaries. Firefox/WebKit,
mobile devices, eviction, user deletion and hardware/power failure are outside
this qualification. It does not claim deployment or remote durability.
