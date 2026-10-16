# Native attachment prerequisite

`NativeAttachments` projects the shared image/reference tuples into AppKit child
views in the same TextKit graph as the surrounding text and native tables.
Image alt/title/source metadata and reference target IDs/labels remain owned
projection data. Native selection captures shared anchors. No document replica,
URL fetcher, upload or implicit activation is introduced.

The embedding host explicitly sets `imageResolver` and `referenceResolver`.
Only a user load/open action calls them. Hosts own permission/allowlist checks,
bounded asset decoding, and cancellation of their work through
`cancelHostRequest`. Completion must run on the main actor. Every completion is
consumed once and checked against request ID, current observed revision, node
descriptor, projection health and disposal. Replacing a host port cancels all
outstanding work. For host permission revocation, clear/replace the port before
accepting more results. Approved reference resolution is delivered to
`onReferenceActivated`; the adapter never launches URLs, processes or files.

Images expose native image/alt metadata, loading, error and cancellation states.
References keep their stored label even when a host supplies a destination.
Controls expose selection, explicit activation, replacement and removal. A trusted
host calls `setPolicy(images:references:)` to enable the default-off shared codecs;
permission remains independent. `replacementProvider` supplies validated inert
same-family metadata, never asset bytes. The Replace button captures a single-use
shared source anchor, exact descriptor and revision before invoking the host.
Cancel, host-port replacement, revision changes and disposal invalidate results.
Remove uses the same capture and portable `atomicContent` command. Both actions
use the existing native command gate and Rust Session admission/history/durability.
Applications may also capture an edit target and call `replace(target:with:)` or
`remove(target:)`. A target belongs to its originating adapter and is consumed at
most once. Host callbacks run on the main actor; nil replacement means cancellation.

Run `bash native/macos/scripts/check.sh attachments` with the pinned Node on PATH.
The suite creates a real Rust document/SQLite checkpoint and restores it through
the generated Swift NativeSession into AppKit. Deterministic host completions
cover presentation, explicit activation, late/cancelled/duplicate/out-of-order
results, shared-revision invalidation, disposal, native selection, layout and
read-only behavior. Resolver transport is prepared; there are no network/provider
calls. Platform, IME, full accessibility and release support remain unqualified.
