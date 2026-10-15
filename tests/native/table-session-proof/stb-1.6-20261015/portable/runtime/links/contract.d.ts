import type { ServiceScope } from './scope.js';
import type { ReferenceCatalogResultV1, ReferencePermissionV1 } from './catalog.js';
/** Host-owned records, portable to native/TUI. None is a semantic command or URL/egress approval. */
export type EnrichmentPolicy = 'disabled' | 'local-paste' | 'explicit-refresh';
export type LinkOrigin = 'local-paste' | 'local-insert' | 'explicit-refresh' | 'open' | 'render' | 'remote' | 'replay' | 'history';
export type LinkState = 'available' | 'unavailable' | 'forbidden' | 'missing' | 'locked' | 'unsupported' | 'canceled' | 'stale';
export interface LinkCapabilities {
    publicMetadata: boolean;
    privateLookup: boolean;
    title: boolean;
    icon: boolean;
    preview: boolean;
    activate: boolean;
    publishMetadata: boolean;
}
export interface LinkHostContext {
    principal: string;
    tenant: string;
    authority: string | null;
    scope: Readonly<ServiceScope>;
    policyRevision: string;
    capabilities: Readonly<LinkCapabilities>;
    readonly: boolean;
}
/** Private identifiers come from ReferenceHostV1.catalog and the shared configured
 * catalog parser. This module does not reimplement its locator/authority grammar. */
export type LinkTarget = {
    kind: 'public';
    url: string;
} | {
    kind: 'private';
    targetId: string;
    authority: string | null;
};
export interface LinkRequest {
    requestId: string;
    cancellationToken: string;
    node: string;
    epoch: string;
    labelRevision: string;
    host: Readonly<LinkHostContext>;
    target: Readonly<LinkTarget>;
    policy: EnrichmentPolicy;
    origin: LinkOrigin;
}
export type LookupAction = 'public' | 'private';
export type LinkAdmission = {
    status: 'ready';
    port: LookupAction;
} | {
    status: Exclude<LinkState, 'available'>;
};
/** Intent only. Hosts validate connection/locator/capabilities at execution time.
 * Copy is independent of credentials; deliberate sharing requires write/disclosure authority. */
export type LinkAction = {
    kind: 'lookup';
    request: Readonly<LinkRequest>;
    port: LookupAction;
} | {
    kind: 'activate';
    request: Readonly<LinkRequest>;
} | {
    kind: 'copy-locator';
    target: Readonly<LinkTarget>;
} | {
    kind: 'commit-metadata';
    request: Readonly<LinkRequest>;
    sharedLabel: string;
};
export interface LinkFreshness {
    fetchedAt: number;
    expiresAt: number;
    policyRevision: string;
}
export interface LinkDisplay {
    title: string;
    description?: string;
    /** Opaque host-managed handles, never remote URLs. */
    iconAsset?: string;
    imageAsset?: string;
}
export type LinkMetadata = {
    kind: 'public';
    display: Readonly<LinkDisplay>;
    provider: string;
    requestedUrl: string;
    canonicalUrl?: string;
} | {
    kind: 'private';
    display: Readonly<LinkDisplay>;
    targetId: string;
};
/** Private display is per-viewer state by default, never a shared node attribute. */
export type LinkOutcome = {
    status: 'available';
    metadata: Readonly<LinkMetadata>;
    freshness: Readonly<LinkFreshness>;
} | {
    status: Exclude<LinkState, 'available'>;
};
export interface LinkResult {
    request: Readonly<LinkRequest>;
    outcome: Readonly<LinkOutcome>;
}
/** Hosts own credentials, URL/actual-connection admission, scheduling and cache.
 * A private endpoint never falls back to privileged public retrieval. */
export interface LinkHostPorts {
    publicMetadata(request: Readonly<LinkRequest>, signal: AbortSignal): Promise<LinkOutcome>;
    privateCatalog(request: Readonly<LinkRequest>, signal: AbortSignal): Promise<LinkOutcome>;
}
export declare const LINK_LIMITS: Readonly<{
    locator: 8192;
    text: 512;
    description: 2048;
}>;
export declare function validLinkRequest(request: Readonly<LinkRequest>): boolean;
/** Shape/size only. Copy/activate intents still require downstream safe-locator admission. */
export declare function validLinkAction(action: Readonly<LinkAction>): boolean;
/** Pure admission; opening/rendering/replay/history never invokes a host port. */
export declare function admitLinkRequest(request: Readonly<LinkRequest>, current: Readonly<LinkHostContext>, canceled?: boolean): LinkAdmission;
/** Adapt the existing transient reference permission; insert is never a lookup grant. */
export declare function referencePermissionProjection(scope: Readonly<ServiceScope>, permission: Readonly<ReferencePermissionV1>): Readonly<ServiceScope>;
/** Capture by value before asynchronous work; host reentrancy cannot rewrite the ticket. */
export declare function captureLinkRequest(request: Readonly<LinkRequest>): Readonly<LinkRequest>;
/** A host intent still requires validated URL/deep-link execution downstream. */
export declare function linkIntentPermission(request: Readonly<LinkRequest>, current: Readonly<LinkHostContext>, intent: 'activate' | 'commit-metadata'): LinkState;
/** Same non-disclosing projection as Rust Catalog::resolve. */
export declare function referenceCatalogState(result: Readonly<ReferenceCatalogResultV1>): LinkState;
/** Exact request ticket and owning target equality; host authority is checked separately. */
export declare function sameLinkRequest(a: Readonly<LinkRequest>, b: Readonly<LinkRequest>): boolean;
export declare function validateLinkResult(result: Readonly<LinkResult>, current: Readonly<LinkRequest>, now: number, canceled?: boolean): LinkState;
