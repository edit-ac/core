# Optional completion backend recipe

This local, private backend uses pinned `ai@7.0.143` and provider protocol
`@ai-sdk/provider@4.0.29`. It is separate from editor bundles and requires an
explicit host-supplied model object. It does not discover credentials or select
an ambient provider/gateway. Automated qualification uses only MockLanguageModelV4.

Install with `npm ci --prefix examples/ai-completion-backend --ignore-scripts`.
The repository's `npm run test:web -- ai-completion` runs the prepared backend
checks and packed browser suite. No provider calls or model quality claims occur.

`completionBackend({ model, requests, contextBytes, outputBytes,
maxOutputTokens, timeoutMs, admit })` returns the portable AiTransport shape.
Mount behind the host's authenticated transport; enforce request body bounds,
identity, policy and account quota before forwarding. The frontend abort signal
must propagate through the HTTP handler into `send(request, signal)`.
`admit` reserves account quota synchronously and must deny unauthorized context.
Every admitted attempt consumes the backend's hard per-instance request cap.
Hosts retain account quota across backend/editor reconfiguration.

The default response uses one `generateText` operation, at most 256 output tokens
and 1,024 UTF-8 bytes, with `maxRetries: 0`, an explicit deadline and no tools or
streamed ghost text. Hosts must disable any additional provider-owned retries.
Only complete plain text is emitted; byte overflow, tools, empty output and abort
fail without a suggestion. Unknown usage is null. No price or settlement estimate
is inferred. The prepared test module is test-only; it is not a live backend.
