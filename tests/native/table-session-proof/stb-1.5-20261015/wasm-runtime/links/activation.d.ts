import type { ReferenceCatalogResultV1 } from './catalog.js';
import type { LinkAction, LinkHostContext, LinkRequest, LinkState, LinkTarget } from './contract.js';
/** Data only: native adapters pass these fields to platform APIs, never a shell. */
export type ValidatedLinkAction = {
    kind: 'open-external';
    locator: string;
    target: Readonly<LinkTarget>;
} | {
    kind: 'open-private';
    locator: string;
    target: Readonly<LinkTarget>;
} | {
    kind: 'copy-locator';
    locator: string;
    target: Readonly<LinkTarget>;
};
export interface LinkActivationOptions {
    context(): Readonly<LinkHostContext>;
    /** Read the owning node/mark now. Undefined means deleted/disposed. Never read metadata. */
    current(request: Readonly<LinkRequest>): Readonly<LinkRequest> | undefined;
    catalog: {
        catalog(targetId: string): Readonly<ReferenceCatalogResultV1>;
    };
    /** Configured catalog adapter supplies a credential-free app/ac/HTTPS locator.
     * It must preserve exact identity and never fetch or mint access tokens. */
    privateLocator(target: Readonly<Extract<LinkTarget, {
        kind: 'private';
    }>>): string | undefined;
    /** Synchronous dispatch to a host navigation/clipboard API. The host must check
     * actual launch authority again if it queues work beyond this call. */
    dispatch(action: Readonly<ValidatedLinkAction>): LinkState;
}
/** Explicit user-action boundary. Construction/rendering performs no host work.
 * No resolver result, cached title, canonical URL or document write is consumed. */
export declare class LinkActivation {
    #private;
    private readonly options;
    constructor(options: LinkActivationOptions);
    dispose(): void;
    perform(action: Readonly<Extract<LinkAction, {
        kind: 'activate';
    }>>, signal?: AbortSignal): LinkState;
    /** Requires owning request identity as well as the portable copy intent, so
     * revoked private targets cannot disclose a locator through stale copy UI. */
    copy(request: Readonly<LinkRequest>, signal?: AbortSignal): LinkState;
}
