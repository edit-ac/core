import { captureLinkRequest, linkIntentPermission, sameLinkRequest, validLinkRequest, validateLinkResult } from './contract.js';
/** Headless presenter boundary shared by native/TUI adapters. It performs no IO,
 * retains no resolved metadata and never commits a label. Hosts supply the current
 * owning request on every read, rerender on revocation/expiry, and own focus/a11y. */
export class LinkPresenterSession {
    signal;
    request;
    #disposed = false;
    #fallback;
    constructor(request, authoredLabel, signal) {
        this.signal = signal;
        this.request = captureLinkRequest(request);
        // Only display normalization; shared authored content remains untouched.
        this.#fallback = authoredLabel.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').slice(0, 512) || 'Link';
    }
    dispose() { this.#disposed = true; }
    present(result, current, now) {
        const canceled = this.#disposed || this.signal?.aborted === true;
        // Validate both the captured owner and result. A result for a different ticket
        // cannot supply display even if it happens to match the new current request.
        const owner = canceled ? 'canceled' : !validLinkRequest(current) ? 'unsupported'
            : !sameLinkRequest(this.request, current) ? 'stale'
                : validateLinkResult({ request: this.request, outcome: { status: 'unavailable' } }, current, now);
        const state = owner === 'unavailable' ? validateLinkResult(result, this.request, now, canceled) : owner;
        const actions = [];
        if (!canceled && owner === 'unavailable' && ['available', 'unavailable'].includes(state)) {
            if (linkIntentPermission(this.request, current.host, 'activate') === 'available')
                actions.push(Object.freeze({ kind: 'activate', request: this.request }));
            // Copy remains an intent. LinkActivation.copy must revalidate owning target,
            // catalog permission and credential-free locator before dispatch.
            actions.push(Object.freeze({ kind: 'copy-locator', target: this.request.target }));
        }
        const available = state === 'available' && result.outcome.status === 'available' ? result.outcome : undefined;
        return Object.freeze({ state, label: this.#fallback,
            ...(available ? { display: Object.freeze({ ...available.metadata.display }), freshness: Object.freeze({ ...available.freshness }) } : {}),
            actions: Object.freeze(actions) });
    }
}
