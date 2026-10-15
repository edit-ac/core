import { serviceScopeFailure, validServiceScope } from '../../services/lifecycle.js';
import type { ServiceScope } from '../../services/lifecycle.js';
import type { ReferenceCatalogResultV1, ReferencePermissionV1 } from '../references.js';

/** Host-owned records, portable to native/TUI. None is a semantic command or URL/egress approval. */
export type EnrichmentPolicy = 'disabled' | 'local-paste' | 'explicit-refresh';
export type LinkOrigin = 'local-paste' | 'local-insert' | 'explicit-refresh' | 'open' | 'render' | 'remote' | 'replay' | 'history';
export type LinkState = 'available' | 'unavailable' | 'forbidden' | 'missing' | 'locked' | 'unsupported' | 'canceled' | 'stale';
export interface LinkCapabilities {
  publicMetadata: boolean; privateLookup: boolean; title: boolean; icon: boolean;
  preview: boolean; activate: boolean; publishMetadata: boolean;
}
export interface LinkHostContext {
  principal: string; tenant: string; authority: string | null;
  scope: Readonly<ServiceScope>; policyRevision: string;
  capabilities: Readonly<LinkCapabilities>; readonly: boolean;
}
/** Private identifiers come from ReferenceHostV1.catalog and the shared configured
 * catalog parser. This module does not reimplement its locator/authority grammar. */
export type LinkTarget = { kind: 'public'; url: string } | { kind: 'private'; targetId: string; authority: string | null };
export interface LinkRequest {
  requestId: string; cancellationToken: string; node: string; epoch: string; labelRevision: string;
  host: Readonly<LinkHostContext>; target: Readonly<LinkTarget>; policy: EnrichmentPolicy; origin: LinkOrigin;
}
export type LookupAction = 'public' | 'private';
export type LinkAdmission = { status: 'ready'; port: LookupAction } | { status: Exclude<LinkState, 'available'> };
/** Intent only. Hosts validate connection/locator/capabilities at execution time.
 * Copy is independent of credentials; deliberate sharing requires write/disclosure authority. */
export type LinkAction =
  | { kind: 'lookup'; request: Readonly<LinkRequest>; port: LookupAction }
  | { kind: 'activate'; request: Readonly<LinkRequest> }
  | { kind: 'copy-locator'; target: Readonly<LinkTarget> }
  | { kind: 'commit-metadata'; request: Readonly<LinkRequest>; sharedLabel: string };
export interface LinkFreshness { fetchedAt: number; expiresAt: number; policyRevision: string }
export interface LinkDisplay {
  title: string; description?: string;
  /** Opaque host-managed handles, never remote URLs. */
  iconAsset?: string; imageAsset?: string;
}
export type LinkMetadata =
  | { kind: 'public'; display: Readonly<LinkDisplay>; provider: string; requestedUrl: string; canonicalUrl?: string }
  | { kind: 'private'; display: Readonly<LinkDisplay>; targetId: string };
/** Private display is per-viewer state by default, never a shared node attribute. */
export type LinkOutcome =
  | { status: 'available'; metadata: Readonly<LinkMetadata>; freshness: Readonly<LinkFreshness> }
  | { status: Exclude<LinkState, 'available'> };
export interface LinkResult { request: Readonly<LinkRequest>; outcome: Readonly<LinkOutcome> }
/** Hosts own credentials, URL/actual-connection admission, scheduling and cache.
 * A private endpoint never falls back to privileged public retrieval. */
export interface LinkHostPorts {
  publicMetadata(request: Readonly<LinkRequest>, signal: AbortSignal): Promise<LinkOutcome>;
  privateCatalog(request: Readonly<LinkRequest>, signal: AbortSignal): Promise<LinkOutcome>;
}
export const LINK_LIMITS = Object.freeze({ locator: 8192, text: 512, description: 2048 });
const bounded = (s: unknown, limit: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(s);
const capabilityKeys = ['publicMetadata', 'privateLookup', 'title', 'icon', 'preview', 'activate', 'publishMetadata'] as const;
function validHost(host: Readonly<LinkHostContext>): boolean {
  return !!host && validServiceScope(host.scope) && [host.principal, host.tenant, host.policyRevision].every(s => bounded(s, 512))
    && (host.authority === null || bounded(host.authority, 63)) && typeof host.readonly === 'boolean'
    && !!host.capabilities && capabilityKeys.every(k => typeof host.capabilities[k] === 'boolean');
}
function validTarget(t: Readonly<LinkTarget>): boolean {
  return !!t && (t.kind === 'public' ? bounded(t.url, 8192) : t.kind === 'private' && bounded(t.targetId, 8192) && (t.authority === null || bounded(t.authority, 63)));
}
export function validLinkRequest(request: Readonly<LinkRequest>): boolean {
  if (!request || !validHost(request.host) || ![request.requestId, request.cancellationToken, request.node, request.epoch, request.labelRevision].every(s => bounded(s, 512))
    || !['disabled', 'local-paste', 'explicit-refresh'].includes(request.policy)
    || !['local-paste', 'local-insert', 'explicit-refresh', 'open', 'render', 'remote', 'replay', 'history'].includes(request.origin)) return false;
  return validTarget(request.target);
}
/** Shape/size only. Copy/activate intents still require downstream safe-locator admission. */
export function validLinkAction(action: Readonly<LinkAction>): boolean {
  if (!action) return false;
  switch (action.kind) {
    case 'copy-locator': return validTarget(action.target);
    case 'lookup': return validLinkRequest(action.request) && action.port === action.request.target.kind;
    case 'activate': return validLinkRequest(action.request);
    case 'commit-metadata': return validLinkRequest(action.request) && bounded(action.sharedLabel, 512);
    default: return false;
  }
}
/** Pure admission; opening/rendering/replay/history never invokes a host port. */
export function admitLinkRequest(request: Readonly<LinkRequest>, current: Readonly<LinkHostContext>, canceled = false): LinkAdmission {
  if (!validLinkRequest(request) || !validHost(current)) return { status: 'unsupported' };
  if (canceled) return { status: 'canceled' };
  const expected = request.host;
  if (expected.principal !== current.principal || expected.tenant !== current.tenant || expected.authority !== current.authority
    || !expected.scope.authorized || !current.scope.authorized || expected.scope.permission !== current.scope.permission
    || capabilityKeys.some(k => expected.capabilities[k] !== current.capabilities[k])) return { status: 'forbidden' };
  if (serviceScopeFailure(expected.scope, current.scope) || expected.policyRevision !== current.policyRevision) return { status: 'stale' };
  const enabled = request.origin === 'explicit-refresh' ? request.policy !== 'disabled'
    : ['local-paste', 'local-insert'].includes(request.origin) && request.policy === 'local-paste';
  if (!enabled) return { status: 'unavailable' };
  if (request.target.kind === 'public' && current.capabilities.publicMetadata) return { status: 'ready', port: 'public' };
  if (request.target.kind === 'private' && current.capabilities.privateLookup && request.target.authority === current.authority) return { status: 'ready', port: 'private' };
  return { status: 'forbidden' };
}
/** Adapt the existing transient reference permission; insert is never a lookup grant. */
export function referencePermissionProjection(scope: Readonly<ServiceScope>, permission: Readonly<ReferencePermissionV1>): Readonly<ServiceScope> {
  return Object.freeze({ ...scope, permission: permission.revision, authorized: permission.lookup });
}
/** Capture by value before asynchronous work; host reentrancy cannot rewrite the ticket. */
export function captureLinkRequest(request: Readonly<LinkRequest>): Readonly<LinkRequest> {
  if (!validLinkRequest(request)) throw new Error('Invalid link request');
  return Object.freeze({ ...request, target: Object.freeze({ ...request.target }), host: Object.freeze({ ...request.host,
    scope: Object.freeze({ ...request.host.scope }), capabilities: Object.freeze({ ...request.host.capabilities }) }) });
}
/** A host intent still requires validated URL/deep-link execution downstream. */
export function linkIntentPermission(request: Readonly<LinkRequest>, current: Readonly<LinkHostContext>, intent: 'activate' | 'commit-metadata'): LinkState {
  // Reuse the same identity/permission freshness rules without requiring lookup
  // policy or a metadata-fetch capability for authorized navigation.
  if (!validLinkRequest(request) || !validHost(current)) return 'unsupported';
  const a = request.host;
  if (a.principal !== current.principal || a.tenant !== current.tenant || a.authority !== current.authority || !a.scope.authorized
    || !current.scope.authorized || a.scope.permission !== current.scope.permission || capabilityKeys.some(k => a.capabilities[k] !== current.capabilities[k])) return 'forbidden';
  if (serviceScopeFailure(a.scope, current.scope) || a.policyRevision !== current.policyRevision) return 'stale';
  if (request.target.kind === 'private' && request.target.authority !== current.authority) return 'forbidden';
  return (intent === 'activate' ? current.capabilities.activate : !current.readonly && current.capabilities.publishMetadata) ? 'available' : 'forbidden';
}
/** Same non-disclosing projection as Rust Catalog::resolve. */
export function referenceCatalogState(result: Readonly<ReferenceCatalogResultV1>): LinkState {
  switch (result.status) {
    case 'local': case 'cached': case 'hosted': return 'available';
    case 'locked': return 'locked';
    case 'incompatible': return 'unsupported';
    case 'unavailable': case 'unauthorized': return 'unavailable';
    default: return 'unsupported';
  }
}
function sameRequest(a: Readonly<LinkRequest>, b: Readonly<LinkRequest>): boolean {
  const targetEqual = a.target.kind === 'public' ? b.target.kind === 'public' && a.target.url === b.target.url
    : b.target.kind === 'private' && a.target.targetId === b.target.targetId && a.target.authority === b.target.authority;
  return targetEqual && a.requestId === b.requestId && a.cancellationToken === b.cancellationToken && a.node === b.node && a.epoch === b.epoch
    && a.labelRevision === b.labelRevision && a.policy === b.policy && a.origin === b.origin && a.host.readonly === b.host.readonly;
}
export function validateLinkResult(result: Readonly<LinkResult>, current: Readonly<LinkRequest>, now: number, canceled = false): LinkState {
  if (!validLinkRequest(result.request) || !validLinkRequest(current)) return 'unsupported';
  const admitted = admitLinkRequest(result.request, current.host, canceled);
  if (admitted.status !== 'ready') return admitted.status;
  if (!sameRequest(result.request, current)) return 'stale';
  const o = result.outcome;
  if (!o || !['available', 'unavailable', 'forbidden', 'missing', 'locked', 'unsupported', 'canceled', 'stale'].includes(o.status)) return 'unsupported';
  if (o.status !== 'available') return o.status;
  const f = o.freshness;
  if (!f || ![now, f.fetchedAt, f.expiresAt].every(n => Number.isSafeInteger(n) && n >= 0) || f.fetchedAt > now || f.expiresAt <= now || f.policyRevision !== current.host.policyRevision) return 'stale';
  const m = o.metadata;
  if (!m || (m.kind === 'public' ? current.target.kind !== 'public' || m.requestedUrl !== current.target.url || !bounded(m.provider, 512)
    || (m.canonicalUrl !== undefined && !bounded(m.canonicalUrl, 8192)) : m.kind !== 'private' || current.target.kind !== 'private' || m.targetId !== current.target.targetId)) return 'unsupported';
  const d = m.display;
  if (!d || !bounded(d.title, 512) || (d.description !== undefined && !bounded(d.description, 2048))
    || [d.iconAsset, d.imageAsset].some(s => s !== undefined && (!bounded(s, 512) || !/^[a-zA-Z0-9_.-]+$/u.test(s)))) return 'unsupported';
  const cap = current.host.capabilities;
  if (m.kind === 'private' && (!cap.title || (d.iconAsset !== undefined && !cap.icon) || ((d.description !== undefined || d.imageAsset !== undefined) && !cap.preview))) return 'forbidden';
  return 'available';
}
