import { safeLink } from './locator.js';
import { captureLinkRequest, linkIntentPermission, validLinkAction } from './contract.js';
const secretKey = /(?:^|[_-])(?:token|key|authorization|auth|password|passwd|secret|signature|credential|bearer|code)(?:$|[_-])/iu;
function locator(value, external) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)
        || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value))
        return;
    try {
        const url = new URL(value);
        if (url.username || url.password || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(k => secretKey.test(k)))
            return;
        if (external)
            return ['http:', 'https:'].includes(url.protocol) && safeLink(value, value) ? value : undefined;
        // Custom schemes are accepted only via the configured catalog port below.
        // Query/fragment payloads cannot smuggle credentials or commands into apps.
        if (['http:', 'https:'].includes(url.protocol))
            return safeLink(value, value) ? value : undefined;
        if (!/^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) || ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol)
            || !url.hostname || url.search || url.hash || url.port)
            return;
        return value;
    }
    catch {
        return;
    }
}
function sameIdentity(a, b) {
    return a.node === b.node && a.epoch === b.epoch && a.requestId === b.requestId && a.cancellationToken === b.cancellationToken
        && a.target.kind === b.target.kind && (a.target.kind === 'public'
        ? b.target.kind === 'public' && a.target.url === b.target.url
        : b.target.kind === 'private' && a.target.targetId === b.target.targetId && a.target.authority === b.target.authority);
}
/** Explicit user-action boundary. Construction/rendering performs no host work.
 * No resolver result, cached title, canonical URL or document write is consumed. */
export class LinkActivation {
    options;
    #disposed = false;
    constructor(options) {
        this.options = options;
    }
    dispose() { this.#disposed = true; }
    perform(action, signal) {
        return this.#run(action, false, signal);
    }
    /** Requires owning request identity as well as the portable copy intent, so
     * revoked private targets cannot disclose a locator through stale copy UI. */
    copy(request, signal) {
        return this.#run({ kind: 'activate', request }, true, signal);
    }
    #run(action, copy, signal) {
        if (this.#disposed || signal?.aborted)
            return 'canceled';
        if (action?.kind !== 'activate' || !validLinkAction(action))
            return 'unsupported';
        try {
            const request = captureLinkRequest(action.request);
            const check = () => {
                if (this.#disposed || signal?.aborted)
                    return 'canceled';
                const current = this.options.current(request);
                if (!current || !sameIdentity(request, current))
                    return 'stale';
                const host = this.options.context();
                // Copy is independent of navigation and document-write capabilities,
                // but retains current principal/tenant/permission/session validation.
                const expected = copy ? { ...request, host: { ...request.host, capabilities: { ...request.host.capabilities, activate: true } } } : request;
                const now = copy ? { ...host, capabilities: { ...host.capabilities, activate: true } } : host;
                const owningHost = copy ? { ...current.host, capabilities: { ...current.host.capabilities, activate: true } } : current.host;
                const owningState = linkIntentPermission(expected, owningHost, 'activate');
                return owningState === 'available' ? linkIntentPermission(expected, now, 'activate') : owningState;
            };
            let state = check();
            if (state !== 'available')
                return state;
            let value;
            if (request.target.kind === 'public')
                value = locator(request.target.url, true);
            else {
                const entry = this.options.catalog.catalog(request.target.targetId);
                if (!entry || entry.targetId !== request.target.targetId)
                    return 'unsupported';
                switch (entry.status) {
                    case 'locked': return 'locked';
                    case 'unauthorized': return 'forbidden';
                    case 'unavailable': return 'unavailable';
                    case 'incompatible': return 'unsupported';
                    case 'local':
                    case 'cached':
                    case 'hosted': break;
                    default: return 'unsupported';
                }
                value = locator(this.options.privateLocator(request.target), false);
            }
            if (!value)
                return 'unsupported';
            state = check();
            if (state !== 'available')
                return state;
            const approved = Object.freeze({ kind: copy ? 'copy-locator' : request.target.kind === 'public' ? 'open-external' : 'open-private', locator: value, target: request.target });
            const result = this.options.dispatch(approved);
            return ['available', 'unavailable', 'forbidden', 'missing', 'locked', 'unsupported', 'canceled', 'stale'].includes(result) ? result : 'unsupported';
        }
        catch {
            return 'unavailable';
        }
    }
}
