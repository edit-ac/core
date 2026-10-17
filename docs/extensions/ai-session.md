# Optional AI proposal sessions

`AiSession` in `@edit-ac/core/extensions` orchestrates a host-supplied `AiHost`.
It retains bounded ephemeral text until review. `start` supersedes and aborts the
previous generation; stale callbacks cannot replace a newer preview. Each restart
uses the host's normal quota admission. No provider or credential is installed.

Capture a target with `captureAiTarget(engine, range, contextOwners, writable)`
before dispatch. The adapter owns two imported stable anchors and a scoped patch
subscription; it never takes ownership of the caller's selection handles. Supply
all owners contributing to the prompt context. The initial adapter supports a
single paragraph target and paragraph context. It rejects unsupported structures.
Relevant edits invalidate the capture even when undone; unrelated owner edits may
rebase through the engine anchors. The current permission callback is checked at
stream delivery and acceptance. Hosts call `invalidate()` on document/session
switch or permission/read-only transitions, including transitions back to writable.

`state` is an immutable preview value. `accept()` requires a completed nonempty
proposal and a valid captured target. Ask responses remain copy-only. Acceptance
consumes the capture before entering the host commit port, prepares an existing
editor command, and commits one undo group. It returns existing engine result
anchors; their ownership passes to the caller. There is no patch engine, persisted
proposal schema or separate history. `reject()` clears output. `cancel()` aborts
transport and releases the target; `recoveryCopy()` explicitly returns bounded
partial output without writing a clipboard. `dispose()` clears output and releases
resources. Call it before disposing the editor; teardown also tolerates an already
disposed engine.

Rust hosts can use `editac_session::ai_proposal::AiProposal` after portable host
admission. It accepts sequenced prepared transport events, an operation generation
and explicit clock values. Hosts own scheduling and transport cancellation; feed a
terminal error for disconnects and invalidate/cancel on lifecycle transitions.
The companion captures an existing literal-source `ReviewTarget`, then delegates
acceptance to `prepare_review` / `apply_review_as`. It conservatively rejects any
observed Session revision change and requires a fresh review after remote changes.
The TypeScript anchor adapter permits unrelated-owner rebasing. Neither path
changes authoritative engine semantics or implements provider retries.

Qualification uses only prepared output: real Rust Session/Yrs review and real
Node/WASM prepared editor commands. It establishes lifecycle/data-safety behavior,
not model quality, provider cancellation, Vercel SDK runtime compatibility,
browser accessibility/touch mechanics or deployment readiness.

Rust acceptance retains the original typed review error and recovery projection.
A store acknowledgment fault after semantic commit reports `RecoveryRequired`,
with the actual committed projection, instead of claiming an unchanged document.
Recovery and persistence remain Session-owned; acceptance cannot be retried on the
consumed proposal. Async stream errors before acceptance leave content unchanged.
