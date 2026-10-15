# Native document durability

`NativeEditorView.storage` presents the actual serialized Rust Session's local
commit/read observations. `receipt` is the last actual acknowledgment seen on
this owner; restore exposes durable membership through `snapshot` without
inventing a receipt. Pending uploads remain pending while offline. Saved locally
is never a remote synchronization claim. SQLite reports process-crash durability,
not measured power-loss guarantees.

The host opens `view.session` with a granted absolute store path, document/epoch
identity and cached permission. No account or network is needed. The same shared
Session owns the SQLite journal/checkpoint/outbox. Every native edit, command and
history action passes through that owner and its durable commit boundary.

Call `view.storage.bind(window:now:)` to observe native window close and application
backgrounding. Supply the Session's explicit clock; the binding never substitutes
wall time or resets permission expiry. Backgrounding refreshes state; commits
already persist before acknowledgment, so no separate flush exists. The binding
preserves the application's window delegate. In that delegate's document-close
approval path, call `storage.close(completion:)` before closing the window; also
use this barrier before application termination. The will-close notification is
an ordinary teardown safety net and cannot veto an OS termination or window
already closed. It must not be represented as an async termination guarantee.

Close blocks new admission, drains accepted work, checks shared recovery state,
and waits for Rust/SQLite disposal before completing. A storage failure retains
the owner and unjournaled recovery export; close reports failure rather than
silently discarding it. Present `exportRecovery` as unacknowledged salvage, repair
the storage condition, then call `recover` to retry the exact shared retained
update and rebuild projection. Retry close after recovery. `dispose` is the
explicit unconditional teardown primitive; it is not a save operation.

Canonical verification: `bash native/macos/scripts/check.sh durability`. Tests use
actual AppKit/generated Swift/Rust Session/SQLite. A test-only SQLite trigger
causes a real transaction abort and is removed before recovery; it is not a
production fault hook. OS-host results are implementation readiness, not roadmap20
platform, power-loss or release qualification.
