import { serviceScopeFailure, validServiceScope } from './scope.js';
export const LINK_LIMITS = /* @__PURE__ */ Object.freeze({ locator: 8192, text: 512, description: 2048 });
const bounded = (s, limit) => typeof s === 'string' && s.length > 0 && s.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(s);
const capabilityKeys = ['publicMetadata', 'privateLookup', 'title', 'icon', 'preview', 'activate', 'publishMetadata'];
function validHost(host) {
    return !!host && validServiceScope(host.scope) && [host.principal, host.tenant, host.policyRevision].every(s => bounded(s, 512))
        && (host.authority === null || bounded(host.authority, 63)) && typeof host.readonly === 'boolean'
        && !!host.capabilities && capabilityKeys.every(k => typeof host.capabilities[k] === 'boolean');
}
function validTarget(t) {
    return !!t && (t.kind === 'public' ? bounded(t.url, 8192) : t.kind === 'private' && bounded(t.targetId, 8192) && (t.authority === null || bounded(t.authority, 63)));
}
export function validLinkRequest(request) {
    if (!request || !validHost(request.host) || ![request.requestId, request.cancellationToken, request.node, request.epoch, request.labelRevision].every(s => bounded(s, 512))
        || !['disabled', 'local-paste', 'explicit-refresh'].includes(request.policy)
        || !['local-paste', 'local-insert', 'explicit-refresh', 'open', 'render', 'remote', 'replay', 'history'].includes(request.origin))
        return false;
    return validTarget(request.target);
}
/** Shape/size only. Copy/activate intents still require downstream safe-locator admission. */
export function validLinkAction(action) {
    if (!action)
        return false;
    switch (action.kind) {
        case 'copy-locator': return validTarget(action.target);
        case 'lookup': return validLinkRequest(action.request) && action.port === action.request.target.kind;
        case 'activate': return validLinkRequest(action.request);
        case 'commit-metadata': return validLinkRequest(action.request) && bounded(action.sharedLabel, 512);
        default: return false;
    }
}
/** Pure admission; opening/rendering/replay/history never invokes a host port. */
export function admitLinkRequest(request, current, canceled = false) {
    if (!validLinkRequest(request) || !validHost(current))
        return { status: 'unsupported' };
    if (canceled)
        return { status: 'canceled' };
    const expected = request.host;
    if (expected.principal !== current.principal || expected.tenant !== current.tenant || expected.authority !== current.authority
        || !expected.scope.authorized || !current.scope.authorized || expected.scope.permission !== current.scope.permission
        || capabilityKeys.some(k => expected.capabilities[k] !== current.capabilities[k]))
        return { status: 'forbidden' };
    if (serviceScopeFailure(expected.scope, current.scope) || expected.policyRevision !== current.policyRevision)
        return { status: 'stale' };
    const enabled = request.origin === 'explicit-refresh' ? request.policy !== 'disabled'
        : ['local-paste', 'local-insert'].includes(request.origin) && request.policy === 'local-paste';
    if (!enabled)
        return { status: 'unavailable' };
    if (request.target.kind === 'public' && current.capabilities.publicMetadata)
        return { status: 'ready', port: 'public' };
    if (request.target.kind === 'private' && current.capabilities.privateLookup && request.target.authority === current.authority)
        return { status: 'ready', port: 'private' };
    return { status: 'forbidden' };
}
/** Adapt the existing transient reference permission; insert is never a lookup grant. */
export function referencePermissionProjection(scope, permission) {
    return Object.freeze({ ...scope, permission: permission.revision, authorized: permission.lookup });
}
/** Capture by value before asynchronous work; host reentrancy cannot rewrite the ticket. */
export function captureLinkRequest(request) {
    if (!validLinkRequest(request))
        throw new Error('Invalid link request');
    return Object.freeze({ ...request, target: Object.freeze({ ...request.target }), host: Object.freeze({ ...request.host,
            scope: Object.freeze({ ...request.host.scope }), capabilities: Object.freeze({ ...request.host.capabilities }) }) });
}
/** A host intent still requires validated URL/deep-link execution downstream. */
export function linkIntentPermission(request, current, intent) {
    // Reuse the same identity/permission freshness rules without requiring lookup
    // policy or a metadata-fetch capability for authorized navigation.
    if (!validLinkRequest(request) || !validHost(current))
        return 'unsupported';
    const a = request.host;
    if (a.principal !== current.principal || a.tenant !== current.tenant || a.authority !== current.authority || !a.scope.authorized
        || !current.scope.authorized || a.scope.permission !== current.scope.permission || capabilityKeys.some(k => a.capabilities[k] !== current.capabilities[k]))
        return 'forbidden';
    if (serviceScopeFailure(a.scope, current.scope) || a.policyRevision !== current.policyRevision)
        return 'stale';
    if (request.target.kind === 'private' && request.target.authority !== current.authority)
        return 'forbidden';
    return (intent === 'activate' ? current.capabilities.activate : !current.readonly && current.capabilities.publishMetadata) ? 'available' : 'forbidden';
}
/** Same non-disclosing projection as Rust Catalog::resolve. */
export function referenceCatalogState(result) {
    switch (result.status) {
        case 'local':
        case 'cached':
        case 'hosted': return 'available';
        case 'locked': return 'locked';
        case 'incompatible': return 'unsupported';
        case 'unavailable':
        case 'unauthorized': return 'unavailable';
        default: return 'unsupported';
    }
}
/** Exact request ticket and owning target equality; host authority is checked separately. */
export function sameLinkRequest(a, b) {
    const targetEqual = a.target.kind === 'public' ? b.target.kind === 'public' && a.target.url === b.target.url
        : b.target.kind === 'private' && a.target.targetId === b.target.targetId && a.target.authority === b.target.authority;
    return targetEqual && a.requestId === b.requestId && a.cancellationToken === b.cancellationToken && a.node === b.node && a.epoch === b.epoch
        && a.labelRevision === b.labelRevision && a.policy === b.policy && a.origin === b.origin && a.host.readonly === b.host.readonly;
}
export function validateLinkResult(result, current, now, canceled = false) {
    if (!validLinkRequest(result.request) || !validLinkRequest(current))
        return 'unsupported';
    const admitted = admitLinkRequest(result.request, current.host, canceled);
    if (admitted.status !== 'ready')
        return admitted.status;
    if (!sameLinkRequest(result.request, current))
        return 'stale';
    const o = result.outcome;
    if (!o || !['available', 'unavailable', 'forbidden', 'missing', 'locked', 'unsupported', 'canceled', 'stale'].includes(o.status))
        return 'unsupported';
    if (o.status !== 'available')
        return o.status;
    const f = o.freshness;
    if (!f || ![now, f.fetchedAt, f.expiresAt].every(n => Number.isSafeInteger(n) && n >= 0) || f.fetchedAt > now || f.expiresAt <= now || f.policyRevision !== current.host.policyRevision)
        return 'stale';
    const m = o.metadata;
    if (!m || (m.kind === 'public' ? current.target.kind !== 'public' || m.requestedUrl !== current.target.url || !bounded(m.provider, 512)
        || (m.canonicalUrl !== undefined && !bounded(m.canonicalUrl, 8192)) : m.kind !== 'private' || current.target.kind !== 'private' || m.targetId !== current.target.targetId))
        return 'unsupported';
    const d = m.display;
    if (!d || !bounded(d.title, 512) || (d.description !== undefined && !bounded(d.description, 2048))
        || [d.iconAsset, d.imageAsset].some(s => s !== undefined && (!bounded(s, 512) || !/^[a-zA-Z0-9_.-]+$/u.test(s))))
        return 'unsupported';
    const cap = current.host.capabilities;
    if (m.kind === 'private' && (!cap.title || (d.iconAsset !== undefined && !cap.icon) || ((d.description !== undefined || d.imageAsset !== undefined) && !cap.preview)))
        return 'forbidden';
    return 'available';
}
