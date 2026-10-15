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
Controls expose selection and explicit activation; replacement/removal controls
are visibly disabled with an unavailable-port explanation. The current shared
NativeSession always constructs the default HostPolicy, reports image/reference
profiles unavailable, and has no portable content replacement route. Both public
mutation entry points fail closed. This prerequisite does not satisfy DSK-1.11's
full edit-controls acceptance. The parent/I1/V1 stay open pending PRIMARY's shared
policy/command ports and actual successful replacement/removal/history proof.

Run `bash native/macos/scripts/check.sh attachments` with the pinned Node on PATH.
The suite creates a real Rust document/SQLite checkpoint and restores it through
the generated Swift NativeSession into AppKit. Deterministic host completions
cover presentation, explicit activation, late/cancelled/duplicate/out-of-order
results, shared-revision invalidation, disposal, native selection, layout and
read-only behavior. Resolver transport is prepared; there are no network/provider
calls. Platform, IME, full accessibility and release support remain unqualified.
